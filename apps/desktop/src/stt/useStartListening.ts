import { useCallback, useRef } from "react";

import { parseJsonContent } from "@hypr/editor/markdown";
import type { JSONContent } from "@hypr/editor/note";
import { commands as analyticsCommands } from "@hypr/plugin-analytics";
import { commands as detectCommands } from "@hypr/plugin-detect";
import type { MeetingCapturedChatMessage } from "@hypr/plugin-detect";
import type { TranscriptStorage } from "@hypr/store";

import { useListener } from "./contexts";
import { useKeywords } from "./useKeywords";
import {
  canRunBatchTranscription,
  isStoppedTranscriptionError,
  useRunBatch,
} from "./useRunBatch";
import { useSTTConnection } from "./useSTTConnection";

import { useShell } from "~/contexts/shell";
import { deleteProcessedAudioForRetention } from "~/services/audio-retention";
import { getEnhancerService } from "~/services/enhancer";
import { getSessionEventById } from "~/session/utils";
import { useConfigValue } from "~/shared/config";
import { id } from "~/shared/utils";
import * as main from "~/store/tinybase/store/main";
import * as settings from "~/store/tinybase/store/settings";
import type {
  LiveTranscriptPersistCallback,
  OnStoppedCallback,
} from "~/store/zustand/listener/transcript";
import {
  getLiveTranscriptionConfig,
  getTranscriptionLanguages,
} from "~/stt/capabilities";
import {
  createTranscriptAccumulator,
  parseTranscriptWords,
  type TranscriptAccumulator,
} from "~/stt/utils";

function hasTranscriptContent(
  store: main.Store,
  indexes: ReturnType<typeof main.UI.useIndexes> | undefined,
  sessionId: string,
) {
  const transcriptIds =
    indexes?.getSliceRowIds(main.INDEXES.transcriptBySession, sessionId) ?? [];

  return transcriptIds.some(
    (transcriptId) => parseTranscriptWords(store, transcriptId).length > 0,
  );
}

const CONSENT_CHAT_MESSAGE =
  "Anarlog is recording and transcribing this meeting. Please reply here if you do not consent.";
const MEETING_CHAT_CAPTURE_INTERVAL_MS = 5_000;

export async function sendConsentRequestToMeetingChat() {
  const result =
    await detectCommands.sendMeetingChatMessage(CONSENT_CHAT_MESSAGE);

  if (result.status === "error") {
    console.warn("[listener] failed to send consent message", result.error);
    return;
  }

  if (!result.data.sent) {
    console.warn(
      "[listener] consent message was not sent",
      result.data.warnings,
    );
  }
}

export function getPostCaptureAction(
  details: {
    audioPath: string | null;
    liveTranscriptionActive: boolean;
  },
  canRunBatch: boolean,
) {
  if (details.liveTranscriptionActive) {
    return "enhance_only" as const;
  }

  if (!!details.audioPath && canRunBatch) {
    return "batch_then_enhance" as const;
  }

  return "none" as const;
}

export function appendCapturedMeetingChatMessagesToRawMd(
  rawMd: string | undefined,
  messages: MeetingCapturedChatMessage[],
  seenSignatures: Set<string>,
) {
  const doc = parseJsonContent(rawMd);
  const existingText = extractNoteText(doc);
  const content = [...(doc.content ?? [])];
  let appended = 0;

  for (const message of messages) {
    const signature = getCapturedMeetingChatSignature(message);
    const line = formatCapturedMeetingChatLine(message);

    if (seenSignatures.has(signature) || existingText.includes(line)) {
      seenSignatures.add(signature);
      continue;
    }

    content.push({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    });
    seenSignatures.add(signature);
    appended += 1;
  }

  if (appended === 0) {
    return { rawMd: rawMd ?? "", appended };
  }

  return {
    rawMd: JSON.stringify({
      ...doc,
      content: trimLeadingEmptyParagraph(content),
    }),
    appended,
  };
}

function startMeetingChatCapture(
  store: main.Store,
  sessionId: string,
): () => void {
  const seenSignatures = new Set<string>();
  let stopped = false;
  let inFlight = false;

  const capture = async () => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;
    try {
      const result = await detectCommands.captureMeetingChatMessages();
      if (result.status === "error") {
        console.warn("[listener] failed to capture meeting chat", result.error);
        return;
      }

      if (result.data.messages.length === 0) {
        return;
      }

      const rawMd = store.getCell("sessions", sessionId, "raw_md");
      const next = appendCapturedMeetingChatMessagesToRawMd(
        typeof rawMd === "string" ? rawMd : undefined,
        result.data.messages,
        seenSignatures,
      );

      if (next.appended > 0) {
        store.setCell("sessions", sessionId, "raw_md", next.rawMd);
      }
    } catch (error) {
      console.warn("[listener] failed to capture meeting chat", error);
    } finally {
      inFlight = false;
    }
  };

  void capture();
  const interval = setInterval(() => {
    void capture();
  }, MEETING_CHAT_CAPTURE_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function formatCapturedMeetingChatLine(message: MeetingCapturedChatMessage) {
  const platform = formatMeetingPlatform(message.platform);
  const metadata = [message.timestamp, message.sender]
    .filter((value): value is string => typeof value === "string" && !!value)
    .join(" ");

  return metadata
    ? `[${platform} chat] ${metadata}: ${message.text}`
    : `[${platform} chat] ${message.text}`;
}

function formatMeetingPlatform(
  platform: MeetingCapturedChatMessage["platform"],
) {
  switch (platform) {
    case "zoom":
      return "Zoom";
    case "slack":
      return "Slack";
    default:
      return "Meeting";
  }
}

function getCapturedMeetingChatSignature(message: MeetingCapturedChatMessage) {
  return [
    message.platform,
    message.sender ?? "",
    message.timestamp ?? "",
    message.text,
  ].join("\n");
}

function extractNoteText(node: JSONContent): string {
  return [
    node.text ?? "",
    ...(node.content?.map((child) => extractNoteText(child)) ?? []),
  ].join("\n");
}

function trimLeadingEmptyParagraph(content: JSONContent[]) {
  if (content.length <= 1) {
    return content;
  }

  const [first, ...rest] = content;
  if (first?.type === "paragraph" && !extractNoteText(first).trim()) {
    return rest;
  }

  return content;
}

export function useStartListening(sessionId: string) {
  const { user_id } = main.UI.useValues(main.STORE_ID);
  const store = main.UI.useStore(main.STORE_ID);
  const indexes = main.UI.useIndexes(main.STORE_ID);
  const settingsStore = settings.UI.useStore(settings.STORE_ID);

  const aiLanguage = useConfigValue("ai_language");
  const spokenLanguages = useConfigValue("spoken_languages");
  const consentAutoSendChat = useConfigValue("consent_auto_send_chat");

  const start = useListener((state) => state.start);
  const { conn } = useSTTConnection();
  const runBatch = useRunBatch(sessionId);
  const { leftsidebar } = useShell();
  const setLeftSidebarExpanded = leftsidebar.setExpanded;

  const keywords = useKeywords(sessionId);
  const runBatchRef = useRef(runBatch);
  const canRunBatchRef = useRef(canRunBatchTranscription(conn));
  const stopMeetingChatCaptureRef = useRef<(() => void) | null>(null);
  runBatchRef.current = runBatch;
  canRunBatchRef.current = canRunBatchTranscription(conn);

  const startListening = useCallback(async () => {
    if (!store) {
      return;
    }

    let transcriptId: string | null = null;
    const startedAt = Date.now();
    const memoMd = store.getCell("sessions", sessionId, "raw_md");
    const createdAt = new Date().toISOString();
    const hadTranscriptBeforeStart = hasTranscriptContent(
      store as main.Store,
      indexes ?? undefined,
      sessionId,
    );
    const transcriptAccumulatorRef: {
      current: TranscriptAccumulator | null;
    } = { current: null };

    const onStopped: OnStoppedCallback = async (_sessionId, details) => {
      stopMeetingChatCaptureRef.current?.();
      stopMeetingChatCaptureRef.current = null;
      transcriptAccumulatorRef.current?.dispose();
      transcriptAccumulatorRef.current = null;

      const postCaptureAction = getPostCaptureAction(
        details,
        canRunBatchRef.current,
      );

      if (postCaptureAction === "batch_then_enhance") {
        try {
          await runBatchRef.current(details.audioPath!);
        } catch (error) {
          if (isStoppedTranscriptionError(error)) {
            return;
          }
          console.error(
            "[listener] failed to run post-capture transcription",
            error,
          );
          return;
        }
      }

      if (postCaptureAction === "none") {
        return;
      }

      const service = getEnhancerService();
      const shouldRegenerateExistingSummary =
        hadTranscriptBeforeStart &&
        (transcriptId !== null || postCaptureAction === "batch_then_enhance");
      if (shouldRegenerateExistingSummary) {
        service?.resetEnhanceTasks(sessionId);
        service?.queueAutoEnhance(sessionId);
      } else {
        service?.queueAutoEnhanceIfSummaryEmpty(sessionId);
      }

      if (settingsStore) {
        await deleteProcessedAudioForRetention(
          store as main.Store,
          settingsStore as settings.Store,
          sessionId,
        );
      }
    };

    const handlePersist: LiveTranscriptPersistCallback = (delta) => {
      if (delta.new_words.length === 0 && delta.replaced_ids.length === 0) {
        return;
      }

      if (!transcriptId) {
        transcriptId = id();
        const transcriptRow = {
          session_id: sessionId,
          user_id: user_id ?? "",
          created_at: createdAt,
          started_at: startedAt,
          words: "[]",
          speaker_hints: "[]",
          memo_md: typeof memoMd === "string" ? memoMd : "",
        } satisfies TranscriptStorage;

        store.setRow("transcripts", transcriptId, transcriptRow);
        transcriptAccumulatorRef.current = createTranscriptAccumulator(
          store,
          transcriptId,
          { words: [], hints: [] },
        );
      }

      transcriptAccumulatorRef.current ??= createTranscriptAccumulator(
        store,
        transcriptId,
      );

      store.transaction(() => {
        transcriptAccumulatorRef.current?.applyLiveDelta(delta);
      });
    };

    const participantHumanIds: string[] = [];
    store.forEachRow(
      "mapping_session_participant",
      (mappingId, _forEachCell) => {
        const sid = store.getCell(
          "mapping_session_participant",
          mappingId,
          "session_id",
        );
        if (sid !== sessionId) return;
        const hid = store.getCell(
          "mapping_session_participant",
          mappingId,
          "human_id",
        );
        if (typeof hid === "string" && hid) {
          participantHumanIds.push(hid);
        }
      },
    );

    const languages = getTranscriptionLanguages(aiLanguage, spokenLanguages);
    const liveTranscriptionConfig = await getLiveTranscriptionConfig({
      provider: conn?.provider,
      model: conn?.model,
      languages,
    });

    const started = await start(
      {
        session_id: sessionId,
        languages: liveTranscriptionConfig.languages,
        onboarding: false,
        model: conn?.model ?? "",
        base_url: conn?.baseUrl ?? "",
        api_key: conn?.apiKey ?? "",
        keywords,
        transcription_mode: liveTranscriptionConfig.transcriptionMode,
        participant_human_ids: participantHumanIds,
        self_human_id: typeof user_id === "string" ? user_id : null,
      },
      {
        handlePersist,
        onStopped,
      },
    );

    if (!started) {
      stopMeetingChatCaptureRef.current?.();
      stopMeetingChatCaptureRef.current = null;
      transcriptAccumulatorRef.current?.dispose();
      transcriptAccumulatorRef.current = null;

      if (transcriptId) {
        store.delRow("transcripts", transcriptId);
      }
      return;
    }

    setLeftSidebarExpanded(false);
    stopMeetingChatCaptureRef.current?.();
    stopMeetingChatCaptureRef.current = startMeetingChatCapture(
      store as main.Store,
      sessionId,
    );

    if (consentAutoSendChat) {
      void sendConsentRequestToMeetingChat();
    }

    void analyticsCommands.event({
      event: "session_started",
      has_calendar_event: !!getSessionEventById(store, sessionId),
      ...(conn
        ? {
            stt_provider: conn.provider,
            stt_model: conn.model,
          }
        : {}),
    });
  }, [
    aiLanguage,
    conn,
    store,
    indexes,
    sessionId,
    start,
    keywords,
    user_id,
    spokenLanguages,
    setLeftSidebarExpanded,
    settingsStore,
    consentAutoSendChat,
  ]);

  return startListening;
}
