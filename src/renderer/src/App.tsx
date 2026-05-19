import { AppErrorBoundary } from "./components/app/AppErrorBoundary";
import { CloseChoiceDialog } from "./components/app/CloseChoiceDialog";
import { DesktopShell } from "./components/app/DesktopShell";

export function App(): React.JSX.Element {
  return (
    <AppErrorBoundary>
      <DesktopShell />
      <CloseChoiceDialog />
    </AppErrorBoundary>
  );
}
