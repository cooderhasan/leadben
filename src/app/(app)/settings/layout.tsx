import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "./tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Ayarlar" />
      <SettingsTabs />
      <div className="mt-6">{children}</div>
    </>
  );
}
