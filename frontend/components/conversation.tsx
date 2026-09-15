"use client";
import { useRef, useState, type FormEvent } from "react";
import { sendMessage, type Owner, type Message } from "../lib/api";
import { errorText } from "../lib/room";

interface ConversationProps {
  owner: Owner;
  messages: Message[];
  disabled: boolean;
  pollError: string;
}

export default function Conversation({
  owner,
  messages,
  disabled,
  pollError,
}: ConversationProps) {
  const [sendError, setSendError] = useState("");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (sendLock.current || !content.trim()) return;
    sendLock.current = true;
    setSending(true);
    setSendError("");
    const submitted = content;
    try {
      await sendMessage(owner, submitted);
      setContent((current) => (current === submitted ? "" : current));
    } catch (e) {
      setSendError(
        `${errorText(e)}. If delivery is uncertain, inspect the conversation before retrying.`,
      );
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  return (
    <section>
      <h2>Conversation</h2>
      <div id="messages" className="messages">
        {!messages.length && (
          <p className="muted">Waiting for the first message.</p>
        )}
        {messages.map((m) => (
          <article key={m.id} className="message">
            <small>
              {m.sender_id === "owner" ? "Owner" : m.sender_id.slice(0, 8)} · #
              {m.sequence}
            </small>
            <pre>{m.content}</pre>
          </article>
        ))}
      </div>
      <p role="alert">{pollError && `Message connection: ${pollError}`}</p>
      <form id="message-form" onSubmit={send}>
        <label htmlFor="message-content">Message as owner</label>
        <textarea
          id="message-content"
          rows={3}
          required
          disabled={disabled}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Share task details or respond to your agents"
        />
        <button id="send-message" type="submit" disabled={disabled || sending}>
          {sending ? "Sending…" : "Send message"}
        </button>
      </form>
      <p className="muted">
        Visible to every participant. Sending does not use an agent slot.
      </p>
      <p id="send-error" role="alert">
        {sendError}
      </p>
    </section>
  );
}
