// Enrolled people — who this organisation's cameras are able to recognise.
//
// This screen is the missing half of face recognition. The model was ready;
// enrolment was a Python script on the server, which no client admin can run.
//
// FIVE THINGS THIS SCREEN IS RESPONSIBLE FOR
//
//  1. Saying what a usable photograph IS, before the upload rather than after.
//     "The system never recognises me" almost always traces back to enrolment
//     photos where the face was too small, and nobody was ever told.
//
//  2. Showing the per-photo verdict. The server answers with a reason for each
//     picture ("face is too small — 22px between the eyes, 40px needed"). Those
//     are the most useful sentences in the product and are shown verbatim.
//
//  3. Never displaying or storing the photographs. Only the derived embedding
//     is kept. Faces are sensitive personal data under India's DPDP Act 2023,
//     and a gallery of employee photos in the UI is a liability with no use.
//
//  4. Making removal obvious and immediate — a data subject's right to erasure
//     has to be one click, and the running worker picks it up within seconds.
//
//  5. Telling the truth about consent. The notice is not decoration: a Data
//     Fiduciary must have consent at collection, and the person enrolling
//     someone is the one who has to obtain it.

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  Pencil,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth, canWrite } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { useToast } from "@/hooks/use-toast";

interface EnrolledPerson {
  name: string;
  images: number;
  enrolledAt: string | null;
  /** The DPDP record: who obtained consent, when, and what for. */
  consent: { by: string; at: string; purpose: string } | null;
}

interface PhotoResult {
  photo: string;
  accepted: boolean;
  reason: string;
}

const MAX_PHOTOS = 10;
const MAX_BYTES = 6 * 1024 * 1024;

/** Read a File as bare base64 (no data: prefix) without touching the disk. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(",");
      resolve(comma > 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(file);
  });
}

export default function FacePeopleView() {
  const auth = useAuth();
  const writable = canWrite(auth.role);
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<PhotoResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // The lawful basis, recorded with the person. A notice on screen is not a
  // record; this is the thing a DPDP audit asks to see.
  const [purpose, setPurpose] = useState("");
  const [consent, setConsent] = useState(false);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<EnrolledPerson | null>(null);
  const [newName, setNewName] = useState("");

  const { data, isLoading, error } = useQuery<
    { people: EnrolledPerson[]; embeddings: number },
    ApiError
  >({
    queryKey: ["/api/face/people"],
    queryFn: async () => (await apiRequest("GET", "/api/face/people")).json(),
    retry: false,
  });

  const reset = () => {
    setName("");
    setFiles([]);
    setPurpose("");
    setConsent(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const enrol = useMutation({
    mutationFn: async () => {
      const images = await Promise.all(files.map(toBase64));
      return (
        await apiRequest("POST", "/api/face/people", {
          name: name.trim(),
          images,
          purpose: purpose.trim(),
          consentConfirmed: consent,
        })
      ).json();
    },
    onSuccess: (res: any) => {
      setResults(res.results ?? null);
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/face/people"] });
      toast({
        title: `${res.name} enrolled`,
        description: `${res.added} of ${files.length} photo(s) used. Cameras pick this up within seconds — no restart.`,
      });
      reset();
    },
    onError: (err: ApiError) => {
      // 422 means the request was fine and the PHOTOS were not. The per-photo
      // reasons are the actionable part, so they are kept on screen.
      setResults(err.body?.results ?? null);
      setFormError(err.message);
      toast({ title: "Nothing was enrolled", description: err.message, variant: "destructive" });
    },
  });

  const remove = useMutation({
    mutationFn: async (person: string) =>
      (await apiRequest("DELETE", `/api/face/people/${encodeURIComponent(person)}`)).json(),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/face/people"] });
      toast({
        title: `${res.name} removed`,
        description: res.wasEnrolled
          ? `${res.removed} face record(s) deleted. Cameras stop recognising them within seconds.`
          : "That person was not enrolled.",
      });
    },
    onError: (err: ApiError) =>
      toast({ title: "Could not remove", description: err.message, variant: "destructive" }),
  });

  const pickFiles = (list: FileList | null) => {
    setResults(null);
    setFormError(null);
    if (!list) return;
    const picked = Array.from(list);
    const tooBig = picked.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) {
      setFormError(
        `${tooBig.map((f) => f.name).join(", ")} — each photo must be under ${
          MAX_BYTES / 1024 / 1024
        } MB.`
      );
    }
    setFiles(picked.filter((f) => f.size <= MAX_BYTES).slice(0, MAX_PHOTOS));
  };

  const all = data?.people ?? [];
  // A gallery of a few hundred staff is a scroll, not a list.
  const people = search.trim()
    ? all.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    : all;
  const rename = useMutation({
    mutationFn: async () =>
      (
        await apiRequest(
          "PATCH",
          `/api/face/people/${encodeURIComponent(renaming!.name)}`,
          { name: newName.trim() }
        )
      ).json(),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/face/people"] });
      toast({
        title: `Renamed to ${res.name}`,
        description: res.mergedIntoExisting
          ? `Merged into the existing ${res.name}. Their photos are now one person.`
          : "Alerts will show the new name from now on.",
      });
      setRenaming(null);
      setNewName("");
    },
    onError: (err: ApiError) =>
      toast({ title: "Could not rename", description: err.message, variant: "destructive" }),
  });

  const canSubmit =
    writable &&
    name.trim().length > 0 &&
    files.length > 0 &&
    purpose.trim().length >= 3 &&
    consent &&
    !enrol.isPending;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {/* ---------------- enrol ---------------- */}
      {writable && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-4 w-4 text-primary" />
              Enrol a person
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertDescription className="text-xs leading-relaxed">
                A face is <strong>sensitive personal data</strong> under the DPDP Act
                2023. Get this person's consent before enrolling them, and tell them
                what it is used for. The photographs are never stored — only a
                mathematical signature is kept, and deleting the person deletes it.
              </AlertDescription>
            </Alert>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="person-name">Name</Label>
                <Input
                  id="person-name"
                  value={name}
                  maxLength={128}
                  placeholder="e.g. Ramesh Kumar"
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-person-name"
                />
                <p className="text-xs text-muted-foreground">
                  This is what appears on alerts, so use the name an operator will
                  recognise.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="person-photos">Photographs</Label>
                <Input
                  id="person-photos"
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png"
                  multiple
                  className="cursor-pointer file:cursor-pointer"
                  onChange={(e) => pickFiles(e.target.files)}
                  data-testid="input-person-photos"
                />
                <p className="text-xs text-muted-foreground">
                  {files.length
                    ? `${files.length} selected`
                    : `Up to ${MAX_PHOTOS} JPEG or PNG files`}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="enrol-purpose">What their face will be used for</Label>
              <Input
                id="enrol-purpose"
                value={purpose}
                maxLength={200}
                placeholder="e.g. Site access control at the main gate"
                onChange={(e) => setPurpose(e.target.value)}
                data-testid="input-purpose"
              />
              <p className="text-xs text-muted-foreground">
                Stored with the person as the lawful basis for holding their
                biometric data. This is what an audit asks to see.
              </p>
            </div>

            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox
                id="enrol-consent"
                checked={consent}
                className="mt-0.5 cursor-pointer"
                onCheckedChange={(c) => setConsent(c === true)}
                data-testid="checkbox-consent"
              />
              <Label htmlFor="enrol-consent" className="cursor-pointer text-sm font-normal leading-relaxed">
                I have this person's consent to enrol their face for the purpose
                above, and they have been told what it is used for.
              </Label>
            </div>

            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs leading-relaxed">
                <strong>What makes a photo work.</strong> Use 3–5 pictures with slightly
                different angles and lighting, and if you can,{" "}
                <strong>take them on the camera that will do the recognising</strong> —
                enrolling a passport photo and then matching an oblique CCTV view is the
                most common reason recognition fails. The face needs at least{" "}
                <strong>40 pixels between the eyes</strong>; anything smaller is rejected
                and told to you rather than quietly accepted.
              </AlertDescription>
            </Alert>

            {formError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            {results && (
              <div className="rounded-md border">
                <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                  Result for each photograph
                </div>
                <ul className="divide-y">
                  {results.map((r) => (
                    <li key={r.photo} className="flex items-start gap-2 px-3 py-2 text-sm">
                      {r.accepted ? (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                      ) : (
                        <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      )}
                      <span className="font-medium capitalize">{r.photo}</span>
                      <span className="text-muted-foreground">{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                className="cursor-pointer"
                disabled={!canSubmit}
                onClick={() => enrol.mutate()}
                data-testid="button-enrol"
              >
                {enrol.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {enrol.isPending ? "Reading the photographs…" : "Enrol"}
              </Button>
              {files.length > 0 && !enrol.isPending && (
                <Button variant="ghost" className="cursor-pointer" onClick={reset}>
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------------- gallery ---------------- */}
      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Enrolled people</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {all.length} {all.length === 1 ? "person" : "people"} ·{" "}
              {data?.embeddings ?? 0}{" "}
              {(data?.embeddings ?? 0) === 1 ? "face record" : "face records"}
            </Badge>
          </div>
          {all.length > 5 && (
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a person"
                className="pl-8"
                aria-label="Search enrolled people"
                data-testid="input-search-people"
              />
            </div>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Name</th>
                <th className="p-3">Photographs used</th>
                <th className="p-3">Enrolled</th>
                <th className="p-3">Consent</th>
                {writable && <th className="p-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Reading this organisation's gallery…
                  </td>
                </tr>
              )}
              {!isLoading && all.length > 0 && people.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    Nobody matches “{search}”.
                  </td>
                </tr>
              )}
              {!isLoading && all.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    Nobody is enrolled yet. Until somebody is, cameras report every
                    face as unrecognised and raise no alerts — which is correct, but
                    not useful.
                  </td>
                </tr>
              )}
              {people.map((p) => (
                <tr key={p.name} className="border-b transition-colors last:border-0 hover:bg-muted/50">
                  <td className="p-3 font-medium">{p.name}</td>
                  <td className="p-3">
                    <span className="tabular-nums">{p.images}</span>
                    {/* One photo is enough to enrol and rarely enough to
                        recognise reliably — say so where it is noticed. */}
                    {p.images < 3 && (
                      <span className="ml-2 text-xs text-amber-600 dark:text-amber-500">
                        add more angles for a reliable match
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {formatDate(p.enrolledAt)}
                  </td>
                  <td className="p-3 text-xs">
                    {/* Somebody enrolled before consent was recorded must be
                        visibly missing it, not indistinguishable from a
                        compliant entry. */}
                    {p.consent ? (
                      <span
                        className="text-muted-foreground"
                        title={`Recorded by ${p.consent.by} on ${formatDateTime(p.consent.at)}`}
                      >
                        {p.consent.purpose || "recorded"}
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-500">
                        not recorded
                      </span>
                    )}
                  </td>
                  {writable && (
                    <td className="p-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="cursor-pointer"
                          onClick={() => {
                            setRenaming(p);
                            setNewName(p.name);
                          }}
                          data-testid={`button-rename-${p.name}`}
                        >
                          <Pencil className="mr-1 h-4 w-4" />
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="cursor-pointer text-destructive"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${p.name}? Their face records are deleted permanently ` +
                                  `and cameras stop recognising them.`
                              )
                            ) {
                              remove.mutate(p.name);
                            }
                          }}
                          data-testid={`button-remove-${p.name}`}
                        >
                          <Trash2 className="mr-1 h-4 w-4" />
                          Remove
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Correcting a name. The only previous fix for a typo was to delete the
          person and photograph them again — and two spellings of one person is
          the commonest way a gallery quietly goes wrong. */}
      <Dialog
        open={!!renaming}
        onOpenChange={(o) => {
          if (!o) setRenaming(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename {renaming?.name}</DialogTitle>
            <DialogDescription>
              Changes the name on future alerts. The face records themselves are
              untouched, so recognition is unaffected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-input">Name</Label>
            <Input
              id="rename-input"
              value={newName}
              maxLength={128}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="input-rename"
            />
            {all.some(
              (p) =>
                p.name.toLowerCase() === newName.trim().toLowerCase() &&
                p.name !== renaming?.name
            ) && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Somebody is already called that. Saving will <strong>merge</strong>{" "}
                the two into one person, keeping both sets of photographs.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" className="cursor-pointer" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              disabled={
                !newName.trim() || newName.trim() === renaming?.name || rename.isPending
              }
              onClick={() => rename.mutate()}
              data-testid="button-save-rename"
            >
              {rename.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
