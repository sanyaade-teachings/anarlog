import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  appendCapturedMeetingChatMessagesToRawMd,
  getPostCaptureAction,
  useStartListening,
} from "./useStartListening";

const {
  queueAutoEnhanceMock,
  queueAutoEnhanceIfSummaryEmptyMock,
  resetEnhanceTasksMock,
  startMock,
  runBatchMock,
  useListenerMock,
  useValuesMock,
  useStoreMock,
  useIndexesMock,
  useConfigValueMock,
  useSTTConnectionMock,
  isSupportedLanguagesLiveMock,
  setLeftSidebarExpandedMock,
  settingsUseStoreMock,
  deleteProcessedAudioForRetentionMock,
  mainStoreMock,
  settingsStoreMock,
  sendMeetingChatMessageMock,
  captureMeetingChatMessagesMock,
} = vi.hoisted(() => ({
  queueAutoEnhanceMock: vi.fn(),
  queueAutoEnhanceIfSummaryEmptyMock: vi.fn(),
  resetEnhanceTasksMock: vi.fn(),
  startMock: vi.fn(),
  runBatchMock: vi.fn(),
  useListenerMock: vi.fn(),
  useValuesMock: vi.fn(),
  useStoreMock: vi.fn(),
  useIndexesMock: vi.fn(),
  useConfigValueMock: vi.fn(),
  useSTTConnectionMock: vi.fn(),
  isSupportedLanguagesLiveMock: vi.fn(),
  setLeftSidebarExpandedMock: vi.fn(),
  settingsUseStoreMock: vi.fn(),
  deleteProcessedAudioForRetentionMock: vi.fn(),
  mainStoreMock: {
    getCell: vi.fn((_table: string, _rowId: string, _cell: string) => ""),
    forEachRow: vi.fn(),
    setRow: vi.fn(),
    setCell: vi.fn(),
    delRow: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
  },
  settingsStoreMock: { id: "settings-store" },
  sendMeetingChatMessageMock: vi.fn(),
  captureMeetingChatMessagesMock: vi.fn(),
}));

vi.mock("@hypr/plugin-transcription", () => ({
  commands: {
    isSupportedLanguagesLive: isSupportedLanguagesLiveMock,
  },
}));

vi.mock("./contexts", () => ({
  useListener: useListenerMock,
}));

vi.mock("@hypr/plugin-detect", () => ({
  commands: {
    sendMeetingChatMessage: sendMeetingChatMessageMock,
    captureMeetingChatMessages: captureMeetingChatMessagesMock,
  },
}));

vi.mock("@hypr/editor/markdown", () => ({
  parseJsonContent: (value: string | undefined) => {
    if (!value) {
      return { type: "doc", content: [{ type: "paragraph" }] };
    }

    return JSON.parse(value);
  },
}));

vi.mock("./useKeywords", () => ({
  useKeywords: vi.fn(() => []),
}));

vi.mock("./useRunBatch", () => ({
  STOPPED_TRANSCRIPTION_ERROR_MESSAGE: "Transcription stopped.",
  canRunBatchTranscription: vi.fn(() => true),
  isStoppedTranscriptionError: vi.fn(
    (error: unknown) =>
      (error instanceof Error ? error.message : String(error)) ===
      "Transcription stopped.",
  ),
  useRunBatch: vi.fn(() => runBatchMock),
}));

vi.mock("./useSTTConnection", () => ({
  useSTTConnection: useSTTConnectionMock,
}));

vi.mock("~/services/enhancer", () => ({
  getEnhancerService: vi.fn(() => ({
    queueAutoEnhance: queueAutoEnhanceMock,
    queueAutoEnhanceIfSummaryEmpty: queueAutoEnhanceIfSummaryEmptyMock,
    resetEnhanceTasks: resetEnhanceTasksMock,
  })),
}));

vi.mock("~/services/audio-retention", () => ({
  deleteProcessedAudioForRetention: deleteProcessedAudioForRetentionMock,
}));

vi.mock("~/contexts/shell", () => ({
  useShell: vi.fn(() => ({
    leftsidebar: {
      setExpanded: setLeftSidebarExpandedMock,
    },
  })),
}));

vi.mock("~/session/utils", () => ({
  getSessionEventById: vi.fn(() => null),
}));

vi.mock("~/shared/config", () => ({
  useConfigValue: useConfigValueMock,
}));

vi.mock("~/shared/utils", () => ({
  id: vi.fn(() => "generated-id"),
}));

vi.mock("~/store/tinybase/store/main", () => ({
  STORE_ID: "main",
  INDEXES: {
    transcriptBySession: "transcriptBySession",
  },
  UI: {
    useValues: useValuesMock,
    useStore: useStoreMock,
    useIndexes: useIndexesMock,
  },
}));

vi.mock("~/store/tinybase/store/settings", () => ({
  STORE_ID: "settings",
  UI: {
    useStore: settingsUseStoreMock,
  },
}));

describe("getPostCaptureAction", () => {
  test("runs batch then enhance after record-only capture finishes when audio is available", () => {
    expect(
      getPostCaptureAction(
        {
          audioPath: "/tmp/session.wav",
          liveTranscriptionActive: false,
        },
        true,
      ),
    ).toBe("batch_then_enhance");
  });

  test("enhances immediately when live transcription already completed during recording", () => {
    expect(
      getPostCaptureAction(
        {
          audioPath: "/tmp/session.wav",
          liveTranscriptionActive: true,
        },
        true,
      ),
    ).toBe("enhance_only");
  });

  test("does nothing when batch fallback is needed but no transcription connection is available", () => {
    expect(
      getPostCaptureAction(
        {
          audioPath: "/tmp/session.wav",
          liveTranscriptionActive: false,
        },
        false,
      ),
    ).toBe("none");
  });

  test("does nothing when capture finishes without a saved audio path", () => {
    expect(
      getPostCaptureAction(
        {
          audioPath: null,
          liveTranscriptionActive: false,
        },
        true,
      ),
    ).toBe("none");
  });
});

describe("appendCapturedMeetingChatMessagesToRawMd", () => {
  test("appends captured messages as source-prefixed memo paragraphs", () => {
    const rawMd = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Existing memo" }],
        },
      ],
    });

    const result = appendCapturedMeetingChatMessagesToRawMd(
      rawMd,
      [
        {
          id: "msg-1",
          platform: "zoom",
          surface: "native",
          sender: "Ada",
          timestamp: "10:42 AM",
          text: "Here is the doc https://example.com/spec",
          links: ["https://example.com/spec"],
        },
      ],
      new Set(),
    );

    const parsed = JSON.parse(result.rawMd);

    expect(result.appended).toBe(1);
    expect(parsed.content.at(-1)).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "[Zoom chat] 10:42 AM Ada: Here is the doc https://example.com/spec",
        },
      ],
    });
  });

  test("skips messages already present in the memo", () => {
    const line = "[Slack chat] 9:03 PM Grace: Ship it";
    const rawMd = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: line }],
        },
      ],
    });

    const result = appendCapturedMeetingChatMessagesToRawMd(
      rawMd,
      [
        {
          id: "msg-1",
          platform: "slack",
          surface: "native",
          sender: "Grace",
          timestamp: "9:03 PM",
          text: "Ship it",
          links: [],
        },
      ],
      new Set(),
    );

    expect(result.appended).toBe(0);
  });
});

describe("useStartListening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, "setInterval").mockReturnValue(
      0 as unknown as ReturnType<typeof setInterval>,
    );
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    useListenerMock.mockImplementation((selector) =>
      selector({
        start: startMock,
      }),
    );
    useValuesMock.mockReturnValue({ user_id: "user-1" });
    useIndexesMock.mockReturnValue(null);
    useConfigValueMock.mockImplementation((key) =>
      key === "ai_language"
        ? "en"
        : key === "consent_auto_send_chat"
          ? false
          : [],
    );
    settingsUseStoreMock.mockReturnValue(settingsStoreMock);
    mainStoreMock.getCell.mockImplementation(() => "");
    mainStoreMock.forEachRow.mockImplementation(() => {});
    useSTTConnectionMock.mockReturnValue({
      conn: {
        provider: "hyprnote",
        model: "am-test",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      },
    });
    useStoreMock.mockReturnValue(mainStoreMock);
    startMock.mockResolvedValue(true);
    runBatchMock.mockResolvedValue(undefined);
    isSupportedLanguagesLiveMock.mockResolvedValue({
      status: "ok",
      data: true,
    });
    sendMeetingChatMessageMock.mockResolvedValue({
      status: "ok",
      data: {
        sent: true,
        warnings: [],
      },
    });
    captureMeetingChatMessagesMock.mockResolvedValue({
      status: "ok",
      data: {
        app: null,
        platform: "unknown",
        surface: "unknown",
        messages: [],
        warnings: [],
      },
    });
  });

  test("collapses the left sidebar after listening starts", async () => {
    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(setLeftSidebarExpandedMock).toHaveBeenCalledWith(false);
  });

  test("keeps the left sidebar state when listening fails to start", async () => {
    startMock.mockResolvedValue(false);

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(setLeftSidebarExpandedMock).not.toHaveBeenCalled();
  });

  test("runs batch transcription after record-only capture stops", async () => {
    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    const onStopped = startMock.mock.calls[0]?.[1]?.onStopped;
    expect(onStopped).toBeTypeOf("function");

    await act(async () => {
      await onStopped?.("session-1", {
        durationSeconds: 42,
        audioPath: "/tmp/session.wav",
        requestedLiveTranscription: false,
        liveTranscriptionActive: false,
      });
    });

    expect(runBatchMock).toHaveBeenCalledWith("/tmp/session.wav");
    expect(queueAutoEnhanceIfSummaryEmptyMock).toHaveBeenCalledWith(
      "session-1",
    );
    expect(deleteProcessedAudioForRetentionMock).toHaveBeenCalledWith(
      mainStoreMock,
      settingsStoreMock,
      "session-1",
    );
  });

  test("cleans up processed audio after live capture stops", async () => {
    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    const onStopped = startMock.mock.calls[0]?.[1]?.onStopped;

    await act(async () => {
      await onStopped?.("session-1", {
        durationSeconds: 42,
        audioPath: "/tmp/session.wav",
        requestedLiveTranscription: true,
        liveTranscriptionActive: true,
      });
    });

    expect(runBatchMock).not.toHaveBeenCalled();
    expect(queueAutoEnhanceIfSummaryEmptyMock).toHaveBeenCalledWith(
      "session-1",
    );
    expect(deleteProcessedAudioForRetentionMock).toHaveBeenCalledWith(
      mainStoreMock,
      settingsStoreMock,
      "session-1",
    );
  });

  test("regenerates the summary after resumed live capture writes transcript", async () => {
    useIndexesMock.mockReturnValue({
      getSliceRowIds: vi.fn(() => ["existing-transcript"]),
    });
    mainStoreMock.getCell.mockImplementation((table, _rowId, cell) => {
      if (table === "transcripts" && cell === "words") {
        return JSON.stringify([
          {
            id: "existing-word",
            text: "existing",
            start_ms: 0,
            end_ms: 100,
            channel: 0,
          },
        ]);
      }

      return "";
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    const handlePersist = startMock.mock.calls[0]?.[1]?.handlePersist;
    expect(handlePersist).toBeTypeOf("function");

    act(() => {
      handlePersist?.({
        new_words: [
          {
            id: "new-word",
            text: "new",
            start_ms: 100,
            end_ms: 200,
            channel: 0,
          },
        ],
        replaced_ids: [],
        partials: [],
      });
    });

    const onStopped = startMock.mock.calls[0]?.[1]?.onStopped;

    await act(async () => {
      await onStopped?.("session-1", {
        durationSeconds: 42,
        audioPath: "/tmp/session.wav",
        requestedLiveTranscription: true,
        liveTranscriptionActive: true,
      });
    });

    expect(resetEnhanceTasksMock).toHaveBeenCalledWith("session-1");
    expect(queueAutoEnhanceMock).toHaveBeenCalledWith("session-1");
    expect(queueAutoEnhanceIfSummaryEmptyMock).not.toHaveBeenCalled();
  });

  test("regenerates the summary after resumed batch capture completes", async () => {
    useIndexesMock.mockReturnValue({
      getSliceRowIds: vi.fn(() => ["existing-transcript"]),
    });
    mainStoreMock.getCell.mockImplementation((table, _rowId, cell) => {
      if (table === "transcripts" && cell === "words") {
        return JSON.stringify([
          {
            id: "existing-word",
            text: "existing",
            start_ms: 0,
            end_ms: 100,
            channel: 0,
          },
        ]);
      }

      return "";
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    const onStopped = startMock.mock.calls[0]?.[1]?.onStopped;

    await act(async () => {
      await onStopped?.("session-1", {
        durationSeconds: 42,
        audioPath: "/tmp/session.wav",
        requestedLiveTranscription: false,
        liveTranscriptionActive: false,
      });
    });

    expect(runBatchMock).toHaveBeenCalledWith("/tmp/session.wav");
    expect(resetEnhanceTasksMock).toHaveBeenCalledWith("session-1");
    expect(queueAutoEnhanceMock).toHaveBeenCalledWith("session-1");
    expect(queueAutoEnhanceIfSummaryEmptyMock).not.toHaveBeenCalled();
  });

  test("forces batch transcription for batch-only local models with realtime stored", async () => {
    useSTTConnectionMock.mockReturnValue({
      conn: {
        provider: "hyprnote",
        model: "soniqo-qwen3-small",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      },
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(startMock.mock.calls[0]?.[0]).toMatchObject({
      transcription_mode: "batch",
    });
  });

  test("uses live transcription for realtime local models", async () => {
    useSTTConnectionMock.mockReturnValue({
      conn: {
        provider: "hyprnote",
        model: "soniqo-parakeet-streaming",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      },
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(startMock.mock.calls[0]?.[0]).toMatchObject({
      transcription_mode: "live",
    });
  });

  test("keeps supported non-English realtime local models live", async () => {
    useConfigValueMock.mockImplementation((key) =>
      key === "ai_language"
        ? "de"
        : key === "consent_auto_send_chat"
          ? false
          : ["en"],
    );
    useSTTConnectionMock.mockReturnValue({
      conn: {
        provider: "hyprnote",
        model: "soniqo-parakeet-streaming",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      },
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(startMock.mock.calls[0]?.[0]).toMatchObject({
      languages: ["de"],
      transcription_mode: "live",
    });
  });

  test("keeps realtime local transcription live by filtering unsupported extra spoken languages", async () => {
    useConfigValueMock.mockImplementation((key) =>
      key === "ai_language"
        ? "en"
        : key === "consent_auto_send_chat"
          ? false
          : ["ko"],
    );
    useSTTConnectionMock.mockReturnValue({
      conn: {
        provider: "hyprnote",
        model: "soniqo-parakeet-streaming",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      },
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(startMock.mock.calls[0]?.[0]).toMatchObject({
      languages: ["en"],
      transcription_mode: "live",
    });
  });

  test("uses the main language for Deepgram live capture when extras are unsupported", async () => {
    useConfigValueMock.mockImplementation((key) =>
      key === "ai_language"
        ? "en"
        : key === "consent_auto_send_chat"
          ? false
          : ["ko"],
    );
    useSTTConnectionMock.mockReturnValue({
      conn: {
        provider: "deepgram",
        model: "nova-3-general",
        baseUrl: "https://api.deepgram.com/v1/listen",
        apiKey: "test-key",
      },
    });
    isSupportedLanguagesLiveMock.mockImplementation(
      (_provider, _model, languages) =>
        Promise.resolve({
          status: "ok",
          data: languages.length === 1 && languages[0] === "en",
        }),
    );

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(startMock.mock.calls[0]?.[0]).toMatchObject({
      languages: ["en"],
      transcription_mode: undefined,
    });
  });

  test("does not send the consent chat message when auto-send is disabled", async () => {
    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(sendMeetingChatMessageMock).not.toHaveBeenCalled();
  });

  test("sends the consent chat message after listening starts when auto-send is enabled", async () => {
    useConfigValueMock.mockImplementation((key: string) =>
      key === "ai_language"
        ? "en"
        : key === "consent_auto_send_chat"
          ? true
          : [],
    );

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    await waitFor(() => {
      expect(sendMeetingChatMessageMock).toHaveBeenCalledWith(
        "Anarlog is recording and transcribing this meeting. Please reply here if you do not consent.",
      );
    });
  });

  test("appends captured meeting chat messages to the active session memo", async () => {
    mainStoreMock.getCell.mockImplementation(
      (table: string, rowId: string, cell: string) =>
        table === "sessions" && rowId === "session-1" && cell === "raw_md"
          ? JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] })
          : "",
    );
    captureMeetingChatMessagesMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        app: { id: "us.zoom.xos", name: "Zoom" },
        platform: "zoom",
        surface: "native",
        messages: [
          {
            id: "msg-1",
            platform: "zoom",
            surface: "native",
            sender: "Ada",
            timestamp: "10:42 AM",
            text: "Decision: keep the launch date",
            links: [],
          },
        ],
        warnings: [],
      },
    });

    const { result } = renderHook(() => useStartListening("session-1"));

    await act(async () => {
      await result.current();
    });

    await waitFor(() => {
      expect(mainStoreMock.setCell).toHaveBeenCalledWith(
        "sessions",
        "session-1",
        "raw_md",
        expect.stringContaining(
          "[Zoom chat] 10:42 AM Ada: Decision: keep the launch date",
        ),
      );
    });
  });
});
