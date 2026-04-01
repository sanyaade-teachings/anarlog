import { commands as localLlmCommands } from "@hypr/plugin-local-llm";
import { commands as localSttCommands } from "@hypr/plugin-local-stt";
import { createFileRoute, Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { watch } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";

import { IndividualizationModal } from "@/components/individualization-modal";
import LeftSidebar from "@/components/left-sidebar";
import { LicenseRefreshProvider } from "@/components/license";
import RightPanel from "@/components/right-panel";
import Notifications from "@/components/toast";
import Toolbar from "@/components/toolbar";
import { WelcomeModal } from "@/components/welcome-modal";
import {
  EditModeProvider,
  LeftSidebarProvider,
  NewNoteProvider,
  RightPanelProvider,
  SearchProvider,
  SettingsProvider,
  useHypr,
  useLeftSidebar,
  useRightPanel,
} from "@/contexts";
import { commands } from "@/types";
import { openURL } from "@/utils/shell";
import { commands as analyticsCommands } from "@hypr/plugin-analytics";
import { events as windowsEvents, getCurrentWebviewWindowLabel } from "@hypr/plugin-windows";
import { Button } from "@hypr/ui/components/ui/button";
import { Modal, ModalBody, ModalDescription, ModalFooter, ModalTitle } from "@hypr/ui/components/ui/modal";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@hypr/ui/components/ui/resizable";
import { OngoingSessionProvider, SessionsProvider } from "@hypr/utils/contexts";

const MIGRATION_NOTICE_SHOWN_KEY = "hypr-migration-notice-shown-v0.0.83";

export const Route = createFileRoute("/app")({
  component: Component,
  loader: async ({ context: { sessionsStore, ongoingSessionStore } }) => {
    const isOnboardingNeeded = await commands.isOnboardingNeeded();
    const isIndividualizationNeeded = await commands.isIndividualizationNeeded();
    return { sessionsStore, ongoingSessionStore, isOnboardingNeeded, isIndividualizationNeeded };
  },
});

// still experimental
function ResponsivePanelsManager() {
  const { isExpanded: leftExpanded, setIsExpanded: setLeftExpanded } = useLeftSidebar();
  const { isExpanded: rightExpanded, setIsExpanded: setRightExpanded } = useRightPanel();

  const [wasAutoCollapsed, setWasAutoCollapsed] = useState(false);

  const originalStates = useRef<{ left: boolean; right: boolean } | null>(null);
  const userOverrodeLeft = useRef(false);
  const userOverrodeRight = useRef(false);

  // trackmanual changes during auto-collapse
  useEffect(() => {
    if (wasAutoCollapsed && originalStates.current) {
      if (leftExpanded !== false) {
        userOverrodeLeft.current = true;
      }
      if (rightExpanded !== false) {
        userOverrodeRight.current = true;
      }
    }
  }, [leftExpanded, rightExpanded, wasAutoCollapsed]);

  useEffect(() => {
    const handleResize = () => {
      const BREAKPOINT = 670;
      const currentWidth = window.innerWidth;

      if (currentWidth < BREAKPOINT) {
        if (!wasAutoCollapsed) {
          originalStates.current = { left: leftExpanded, right: rightExpanded };
          userOverrodeLeft.current = false;
          userOverrodeRight.current = false;

          setLeftExpanded(false);
          setRightExpanded(false);
          setWasAutoCollapsed(true);
        }
      } else {
        if (wasAutoCollapsed && originalStates.current) {
          if (!userOverrodeLeft.current) {
            setLeftExpanded(originalStates.current.left);
          }
          if (!userOverrodeRight.current) {
            setRightExpanded(originalStates.current.right);
          }

          setWasAutoCollapsed(false);
          originalStates.current = null;
          userOverrodeLeft.current = false;
          userOverrodeRight.current = false;
        }
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [leftExpanded, rightExpanded, wasAutoCollapsed, setLeftExpanded, setRightExpanded]);

  return null;
}

function Component() {
  const router = useRouter();
  const location = useLocation();
  const { thankYouSessionId, userId } = useHypr();
  const { sessionsStore, ongoingSessionStore, isOnboardingNeeded, isIndividualizationNeeded } = Route.useLoaderData();

  const [onboardingCompletedThisSession, setOnboardingCompletedThisSession] = useState(false);
  const [showMigrationNotice, setShowMigrationNotice] = useState(false);

  const windowLabel = getCurrentWebviewWindowLabel();
  const isMain = windowLabel === "main";
  const shouldShowMigrationNotice = isMain && showMigrationNotice;
  const showNotifications = isMain && !isOnboardingNeeded && !shouldShowMigrationNotice;

  const shouldShowWelcomeModal = isMain && isOnboardingNeeded;
  const shouldShowIndividualization = isMain && isIndividualizationNeeded && !isOnboardingNeeded
    && !onboardingCompletedThisSession;

  useEffect(() => {
    if (!isMain) {
      return;
    }

    if (import.meta.env.DEV) {
      setShowMigrationNotice(true);
      return;
    }

    const hasShownMigrationNotice = localStorage.getItem(MIGRATION_NOTICE_SHOWN_KEY) === "true";
    if (hasShownMigrationNotice) {
      return;
    }

    localStorage.setItem(MIGRATION_NOTICE_SHOWN_KEY, "true");
    setShowMigrationNotice(true);
  }, [isMain]);

  // Check if we're in the finder route
  const isFinderRoute = location.pathname.includes("/finder");

  const content = (
    <SessionsProvider store={sessionsStore}>
      <OngoingSessionProvider store={ongoingSessionStore}>
        <LeftSidebarProvider>
          {isMain
            ? (
              <RightPanelProvider>
                <RestartTTT />
                <RestartSTT />
                <MainWindowStateEventSupport />
                <SettingsProvider>
                  <NewNoteProvider>
                    <SearchProvider>
                      <EditModeProvider>
                        <div className="flex h-screen w-screen overflow-hidden">
                          <LeftSidebar />
                          <div className="flex-1 flex h-screen w-screen flex-col overflow-hidden">
                            <Toolbar />
                            <ResizablePanelGroup
                              direction="horizontal"
                              className="flex-1 overflow-hidden flex"
                              autoSaveId="main"
                            >
                              <ResizablePanel className="flex-1 overflow-hidden">
                                <Outlet />
                              </ResizablePanel>
                              <ResizableHandle className="w-0" />
                              <RightPanel />
                            </ResizablePanelGroup>
                          </div>
                        </div>
                        <ResponsivePanelsManager />
                        <MigrationNoticeModal
                          isOpen={shouldShowMigrationNotice}
                          onClose={() => setShowMigrationNotice(false)}
                        />
                        <WelcomeModal
                          isOpen={shouldShowWelcomeModal && !shouldShowMigrationNotice}
                          onClose={() => {
                            setOnboardingCompletedThisSession(true);
                            analyticsCommands.event({
                              event: "onboarding_all_steps_completed",
                              distinct_id: userId,
                            });
                            if (thankYouSessionId) {
                              router.navigate({ to: `/app/note/${thankYouSessionId}` });
                            }
                            router.invalidate();
                          }}
                        />
                        <IndividualizationModal
                          isOpen={shouldShowIndividualization && !shouldShowMigrationNotice}
                          onClose={() => {
                            commands.setIndividualizationNeeded(false);
                            router.invalidate();
                          }}
                        />
                        {showNotifications && <Notifications />}
                      </EditModeProvider>
                    </SearchProvider>
                  </NewNoteProvider>
                </SettingsProvider>
              </RightPanelProvider>
            )
            : (
              <div className="h-screen w-screen overflow-hidden">
                <Outlet />
              </div>
            )}
        </LeftSidebarProvider>
      </OngoingSessionProvider>
    </SessionsProvider>
  );

  return (
    <>
      {isFinderRoute ? content : (
        <LicenseRefreshProvider>
          {content}
        </LicenseRefreshProvider>
      )}
    </>
  );
}

function MigrationNoticeModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const handleOpen = async (url: string) => {
    try {
      await openURL(url);
    } catch (error) {
      console.error("Failed to open external link:", error);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="lg"
      className="max-h-[calc(100vh-48px)] w-[760px] max-w-[94vw] overflow-hidden border border-neutral-200 bg-background shadow-2xl"
    >
      <ModalBody className="max-h-[calc(100vh-160px)] space-y-5 overflow-y-auto px-8 py-7">
        <div className="space-y-5 rounded-[28px] border border-neutral-200 bg-neutral-50/70 px-10 py-8">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-500">
              A Note From The Char Team
            </div>
            <ModalTitle className="font-serif text-[2.15rem] font-medium leading-tight text-foreground">
              Please move to the new Char app.
            </ModalTitle>
          </div>

          <div className="space-y-4 text-[16px] leading-8 text-neutral-700">
            <p>
              If you are still using this Hyprnote build, thank you. Your notes and the rest of the app should continue
              to work, but new updates are going into Char now.
            </p>
            <p className="text-neutral-900">
              One important exception:{" "}
              <span className="font-semibold">the `PRO` model will stop working in this old app.</span>{" "}
              If you rely on PRO, please move to Char.
            </p>
            <p>
              If you already have PRO, sign in to Char with the same email and your PRO status will carry over. Char
              also includes an explicit data migration flow in Settings.
            </p>
            <p>
              You can download Char from{" "}
              <ExternalTextLink href="https://char.com/download/" onOpen={handleOpen}>
                char.com/download
              </ExternalTextLink>{" "}
              or get it from{" "}
              <ExternalTextLink href="https://github.com/fastrepl/char/releases" onOpen={handleOpen}>
                GitHub Releases
              </ExternalTextLink>.
            </p>
            <p>
              If anything does not work, talk to us in{" "}
              <ExternalTextLink href="https://hyprnote.com/discord" onOpen={handleOpen}>
                Discord
              </ExternalTextLink>{" "}
              or use the chat bubble at{" "}
              <ExternalTextLink href="https://char.com" onOpen={handleOpen}>
                char.com
              </ExternalTextLink>.
            </p>
          </div>

          <div className="pt-2 text-sm text-neutral-500">
            Thanks,
            <div className="mt-1 font-serif text-xl italic text-neutral-900">The Char team</div>
          </div>
        </div>
      </ModalBody>

      <ModalFooter className="border-t border-neutral-200 bg-neutral-50 px-8 py-4">
        <Button variant="outline" onClick={onClose}>
          Dismiss
        </Button>
        <Button
          variant="outline"
          onClick={() => handleOpen("https://github.com/fastrepl/char/releases")}
        >
          View Releases
        </Button>
        <Button
          onClick={() => handleOpen("https://char.com/download/")}
          className="bg-black text-white hover:bg-neutral-800"
        >
          Download Char
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ExternalTextLink({
  children,
  href,
  onOpen,
}: {
  children: React.ReactNode;
  href: string;
  onOpen: (url: string) => Promise<void>;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-neutral-900 underline decoration-neutral-300 underline-offset-4 transition-colors hover:text-black"
      onClick={(e) => {
        e.preventDefault();
        void onOpen(href);
      }}
    >
      {children}
    </a>
  );
}

function RestartTTT() {
  const watcher = async () => {
    const llmPath = await localLlmCommands.modelsDir();

    return watch(llmPath, (_event) => {
      localLlmCommands.restartServer();
    }, { delayMs: 1000 });
  };

  useEffect(() => {
    let unwatch: () => void;

    watcher().then((f) => {
      unwatch = f;
    });

    return () => {
      unwatch?.();
    };
  }, []);

  return null;
}

function RestartSTT() {
  const watcher = async () => {
    const sttPath = await localSttCommands.modelsDir();

    return watch(sttPath, (_event) => {
      localSttCommands.stopServer(null).then((stopped) => {
        if (stopped) {
          localSttCommands.getLocalModel().then((model) => {
            localSttCommands.startServer(model);
          });
        }
      });
    }, { delayMs: 1000 });
  };

  useEffect(() => {
    let unwatch: () => void;

    watcher().then((f) => {
      unwatch = f;
    });

    return () => {
      unwatch?.();
    };
  }, []);

  return null;
}

function MainWindowStateEventSupport() {
  const { setIsExpanded: setLeftSidebarExpanded } = useLeftSidebar();
  const { setIsExpanded: setRightPanelExpanded } = useRightPanel();

  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();
    windowsEvents.mainWindowState(currentWindow).listen(({ payload }) => {
      if (payload.left_sidebar_expanded !== null) {
        setLeftSidebarExpanded(payload.left_sidebar_expanded);
      }

      if (payload.right_panel_expanded !== null) {
        setRightPanelExpanded(payload.right_panel_expanded);
      }
    });
  }, []);

  return null;
}
