import { SidebarProvider } from "@/components/ui/sidebar";
import AppSidebar from "../AppSidebar";
import { useState } from "react";

export default function AppSidebarExample() {
  const [currentPath, setCurrentPath] = useState("/live");

  return (
    <SidebarProvider>
      <div className="flex h-screen w-full">
        <AppSidebar currentPath={currentPath} onNavigate={setCurrentPath} />
        <div className="flex-1 p-6 bg-background">
          <p className="text-foreground">Current path: {currentPath}</p>
        </div>
      </div>
    </SidebarProvider>
  );
}
