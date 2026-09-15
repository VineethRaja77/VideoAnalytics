// "Who is that?" — answered from the alert itself.
//
// An unknown-face alert is a question. Before this, answering it meant opening
// the snapshot, saving the image, switching tabs and uploading it again — five
// steps for the single most common thing an operator wants to do with an
// unknown face. A feature that costs five steps at the moment of interest is a
// feature nobody uses.
//
// The snapshot is also the BEST enrolment photo available: it was taken by the
// very camera that has to do the recognising, at the angle and lighting it
// actually sees. Enrolling a passport photo and matching an oblique CCTV view
// is the most common reason face recognition disappoints in the field.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import type { AnalyticsEvent } from "@/components/ModuleEventsView";

interface Props {
  event: AnalyticsEvent | null;
  onClose: () => void;
}

export default function EnrolFromEventDialog({ event, onClose }: Props) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Existing names, so adding a second photo to somebody already enrolled is a
  // pick rather than a retype. Two spellings of one person are two people to
  // the gallery, and nothing would ever tell the operator that happened.
  const { data } = useQuery<{ people: { name: string }[] }, ApiError>({
    queryKey: ["/api/face/people"],
    queryFn: async () => (await apiRequest("GET", "/api/face/people")).json(),
    retry: false,
    enabled: !!event,
  });

  const enrol = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/face/people/from-event", {
          eventId: event!.id,
          name: name.trim(),
          purpose: purpose.trim(),
          consentConfirmed: consent,
        })
      ).json(),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/face/people"] });
      toast({
        title: `${res.name} enrolled`,
        description:
          `${res.results?.[0]?.reason ?? "Enrolled from this snapshot."} ` +
          `Cameras start recognising them within seconds.`,
      });
      setName("");
      setPurpose("");
      setConsent(false);
      setError(null);
      onClose();
    },
    onError: (err: ApiError) => {
      // 422 carries the per-photo reason — "face is too small", "no face
      // found" — which is the only thing that tells the operator what to do
      // next. It is shown instead of the generic message.
      setError(err.body?.results?.[0]?.reason ?? err.message);
    },
  });

  const existing = data?.people?.map((p) => p.name) ?? [];
  const isExisting = existing.some((n) => n.toLowerCase() === name.trim().toLowerCase());

  return (
    <Dialog open={!!event} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            Who is this?
          </DialogTitle>
          <DialogDescription>
            Enrol this person from the image the camera captured. Because it came
            from this camera, it is a better reference than a studio photograph.
          </DialogDescription>
        </DialogHeader>

        {event && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-md border bg-muted">
              <img
                src={`/api/analytics/events/${event.id}/snapshot`}
                alt="The unrecognised face captured by this camera"
                className="max-h-64 w-full object-contain"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="enrol-name">Name</Label>
              <Input
                id="enrol-name"
                value={name}
                maxLength={128}
                list="enrolled-names"
                placeholder="e.g. Ramesh Kumar"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                data-testid="input-enrol-from-event-name"
              />
              <datalist id="enrolled-names">
                {existing.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              {isExisting ? (
                <p className="text-xs text-muted-foreground">
                  Adds this photo to <strong>{name.trim()}</strong>, who is already
                  enrolled — more angles make future matches more reliable.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Enrols a new person. Check the spelling: a different spelling
                  creates a second person rather than adding to an existing one.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="enrol-event-purpose">What their face will be used for</Label>
              <Input
                id="enrol-event-purpose"
                value={purpose}
                maxLength={200}
                placeholder="e.g. Site access control at the main gate"
                onChange={(e) => {
                  setPurpose(e.target.value);
                  setError(null);
                }}
                data-testid="input-enrol-from-event-purpose"
              />
            </div>

            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox
                id="enrol-event-consent"
                checked={consent}
                className="mt-0.5 cursor-pointer"
                onCheckedChange={(c) => setConsent(c === true)}
                data-testid="checkbox-enrol-from-event-consent"
              />
              <Label
                htmlFor="enrol-event-consent"
                className="cursor-pointer text-sm font-normal leading-relaxed"
              >
                I have this person's consent to enrol their face for the purpose
                above.
              </Label>
            </div>

            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertDescription className="text-xs leading-relaxed">
                A face is <strong>sensitive personal data</strong> under the DPDP Act
                2023. Only enrol someone you have grounds to identify. The
                photograph is not kept — only a mathematical signature, which is
                deleted when the person is removed, and the consent record above.
              </AlertDescription>
            </Alert>

            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" className="cursor-pointer" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="cursor-pointer"
            disabled={!name.trim() || purpose.trim().length < 3 || !consent || enrol.isPending}
            onClick={() => enrol.mutate()}
            data-testid="button-enrol-from-event"
          >
            {enrol.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isExisting ? "Add this photo" : "Enrol"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
