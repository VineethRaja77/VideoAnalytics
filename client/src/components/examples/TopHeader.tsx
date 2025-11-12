import { SidebarProvider } from "@/components/ui/sidebar";
import TopHeader from "../TopHeader";

export default function TopHeaderExample() {
  return (
    <SidebarProvider>
      <div className="w-full bg-background">
        <TopHeader
          notificationCount={3}
          onSearch={(query) => console.log("Search:", query)}
        />
      </div>
    </SidebarProvider>
  );
}
