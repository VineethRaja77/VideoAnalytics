// Face recognition, in the order the work actually happens.
//
// The events feed is what an operator looks at daily, so it leads — EXCEPT
// when nobody is enrolled yet. A face module with an empty gallery reports
// nothing and raises no alerts by design, so landing a new client admin on an
// empty event table would look like a broken product. When the gallery is
// empty this screen opens on enrolment instead, which is the thing that
// actually needs doing.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScanFace } from "lucide-react";
import { apiRequest, type ApiError } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import FaceEventsView from "@/components/FaceEventsView";
import FacePeopleView from "@/components/FacePeopleView";
import ModuleCoverage from "@/components/ModuleCoverage";
import { MODULE_FEATURES } from "@shared/schema";
import type { CameraLite } from "@/components/ModuleEventsView";

export default function FaceView({ cameras, compact = false }: { cameras: CameraLite[]; compact?: boolean }) {
  const [tab, setTab] = useState("events");
  const [decided, setDecided] = useState(false);

  // Same query key as FacePeopleView, so this is one request, not two.
  const { data } = useQuery<{ people: unknown[] }, ApiError>({
    queryKey: ["/api/face/people"],
    queryFn: async () => (await apiRequest("GET", "/api/face/people")).json(),
    retry: false,
  });

  useEffect(() => {
    // Only ever steer the FIRST render. Re-running this after the admin has
    // clicked a tab would drag them back, which is worse than a poor default.
    if (decided || !data) return;
    if ((data.people?.length ?? 0) === 0) setTab("people");
    setDecided(true);
  }, [data, decided]);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {!compact && (
        <>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <ScanFace className="h-5 w-5 text-primary" />
            Face Recognition
          </h2>
          <ModuleCoverage
            features={MODULE_FEATURES.face}
            cameras={cameras}
            what="Face recognition"
          />
        </>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="events" className="cursor-pointer" data-testid="tab-face-events">
            Events
          </TabsTrigger>
          <TabsTrigger value="people" className="cursor-pointer" data-testid="tab-face-people">
            Enrolled people
          </TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="mt-4">
          <FaceEventsView cameras={cameras} hideHeading />
        </TabsContent>
        <TabsContent value="people" className="mt-4">
          <FacePeopleView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
