import { useMemo, useState } from "react";
import { Car, ScanFace, ShieldAlert, UserSquare } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MODULE_FEATURES } from "@shared/schema";
import { hasAnyModule, useAuth } from "@/lib/auth";
import PersonEventsView from "@/components/PersonEventsView";
import AlertsView from "@/components/AlertsView";
import VehicleEventsView from "@/components/VehicleEventsView";
import FaceView from "@/components/FaceView";
import type { CameraLite } from "@/components/ModuleEventsView";

const EVENT_TABS = [
  { id: "person", label: "People", icon: UserSquare, features: MODULE_FEATURES.person },
  { id: "ppe", label: "PPE", icon: ShieldAlert, features: MODULE_FEATURES.ppe },
  { id: "vehicle", label: "Vehicles", icon: Car, features: MODULE_FEATURES.vehicle },
  { id: "face", label: "Faces", icon: ScanFace, features: MODULE_FEATURES.face },
] as const;

export default function EventsCenter({ cameras }: { cameras: CameraLite[] }) {
  const auth = useAuth();
  const tabs = useMemo(() => EVENT_TABS.filter((tab) => hasAnyModule(auth, tab.features)), [auth]);
  const [active, setActive] = useState<string>(tabs[0]?.id ?? "");
  const current = tabs.some((tab) => tab.id === active) ? active : tabs[0]?.id ?? "";

  if (!tabs.length) {
    return (
      <div className="mx-auto max-w-5xl space-y-2">
        <h1 className="text-2xl font-semibold">Events Center</h1>
        <p className="text-sm text-muted-foreground">No analytics event modules are licensed for this organization.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Events Center</h1>
        <p className="mt-1 text-sm text-muted-foreground">Review licensed analytics events from one place.</p>
      </div>
      <Tabs value={current} onValueChange={setActive}>
        <TabsList className="flex h-auto flex-wrap justify-start">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.id} value={tab.id} className="gap-2 cursor-pointer">
                <Icon className="h-4 w-4" /> {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="mt-4">
          {current === "person" && <PersonEventsView cameras={cameras} compact />}
          {current === "ppe" && <AlertsView cameras={cameras} compact />}
          {current === "vehicle" && <VehicleEventsView cameras={cameras} compact />}
          {current === "face" && <FaceView cameras={cameras} compact />}
        </div>
      </Tabs>
    </div>
  );
}
