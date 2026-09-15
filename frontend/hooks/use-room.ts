"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getRoom,
  readMessages,
  type Owner,
  type Room,
  type Message,
} from "../lib/api";
import { errorText, isTerminal } from "../lib/room";

function appendNewMessages(
  previous: Message[],
  incoming: Message[],
): Message[] {
  const knownIds = new Set(previous.map((message) => message.id));
  return [
    ...previous,
    ...incoming.filter((message) => !knownIds.has(message.id)),
  ];
}

function shouldStopPolling(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    [400, 401, 403, 404, 410].includes(error.status)
  );
}

export function useRoom(owner: Owner) {
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const info = await getRoom(owner, signal);
      if (!signal?.aborted) setRoom(info);
    },
    [owner],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const pollRoomStatus = async () => {
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      }
      if (!controller.signal.aborted) timer = setTimeout(pollRoomStatus, 2000);
    };
    void pollRoomStatus();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout>;
    let releaseRetry: (() => void) | undefined;
    const pollMessages = async () => {
      let cursor = 0;
      while (!controller.signal.aborted) {
        try {
          const page = await readMessages(owner, cursor, controller.signal);
          if (controller.signal.aborted) return;
          setPollError("");
          setMessages((previous) => appendNewMessages(previous, page.messages));
          setRoom((previous) =>
            previous
              ? {
                  ...previous,
                  status: page.session_status.toUpperCase(),
                  participants: page.participants,
                }
              : previous,
          );
          cursor = page.cursor;
          if (isTerminal(page.session_status) && !page.messages.length) return;
        } catch (e) {
          if (controller.signal.aborted) return;
          setPollError(errorText(e));
          if (shouldStopPolling(e)) return;
          // Retry reads only. Never automatically repeat an uncertain message POST.
          await new Promise<void>((resolve) => {
            releaseRetry = resolve;
            retryTimer = setTimeout(
              resolve,
              (e instanceof ApiError ? e.retryAfter : 5) * 1000,
            );
          });
        }
      }
    };
    void pollMessages();
    return () => {
      controller.abort();
      clearTimeout(retryTimer);
      releaseRetry?.();
    };
  }, [owner]);

  return { room, messages, error, setError, pollError, refresh };
}
