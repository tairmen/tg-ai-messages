import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  NumberInput,
  Select,
  Switch,
  Textarea,
  Badge,
} from "@mantine/core";

export default function AiConversationSettings({
  api,
  contacts,
  refreshContacts,
  masterEnabled,
}) {
  const [groups, setGroups] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [more, setMore] = useState(false);
  const [target, setTarget] = useState(null);
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    setNotice("");
    setForm(null);
    setSaved(null);
    if (!target) return;
    setLoading(true);
    const [kind, id] = target.split(":");
    api(
      kind === "group"
        ? "/groups/" + id + "/ai"
        : "/conversations/" + id + "?limit=1",
    )
      .then((data) => {
        if (!live) return;
        const value = data.group || data.contact;
        setSaved(value);
        setForm({
          ai_enabled: value.ai_enabled,
          ai_instructions: value.ai_instructions,
          ai_mode: value.ai_mode,
          ai_interval_minutes: value.ai_interval_minutes,
        });
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [target, reload, api]);
  async function loadGroups(append = false) {
    setLoading(true);
    setError("");
    try {
      const result = await api(
        "/groups?limit=100" +
          (append && cursor ? "&offset_date=" + cursor : ""),
      );
      setGroups((previous) =>
        Array.from(
          new Map(
            [...(append ? previous : []), ...result.groups].map((g) => [
              g.id,
              g,
            ]),
          ).values(),
        ),
      );
      setCursor(result.next_offset_date);
      setMore(result.may_have_more);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const [kind, id] = target.split(":");
      const value = await api(
        (kind === "group" ? "/groups/" : "/contacts/") + id,
        "PATCH",
        form,
      );
      setSaved(value);
      setNotice("Settings saved");
      await refreshContacts();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="card padded" style={{ marginTop: 24 }}>
      <h2>AI for groups & private chats</h2>
      <p className="muted">
        Choose immediate replies or recurring checks. During each scheduled
        check, AI reads recent history and decides whether your conditions call
        for a message.
      </p>
      {!masterEnabled && (
        <Alert color="yellow" mb="md">
          The global AI switch is paused. Save and enable it above to allow
          automatic messages.
        </Alert>
      )}
      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert color="teal" mb="md">
          {notice}
        </Alert>
      )}
      <div className="row" style={{ marginBottom: 16 }}>
        <Button
          variant="light"
          loading={loading}
          disabled={saving}
          onClick={() => loadGroups(false)}
        >
          Load Telegram groups
        </Button>
        {more && (
          <Button
            variant="subtle"
            disabled={loading || saving}
            onClick={() => loadGroups(true)}
          >
            Load more groups
          </Button>
        )}
      </div>
      <Select
        label="Conversation"
        placeholder="Select a contact or load groups"
        searchable
        value={target}
        disabled={saving || loading}
        onChange={setTarget}
        data={[
          {
            group: "Private chats",
            items: contacts.map((c) => ({
              value: "contact:" + c.id,
              label: c.name + " (#" + c.id + ")",
            })),
          },
          {
            group: "Groups",
            items: groups.map((g) => ({
              value: "group:" + g.id,
              label: g.title + " (#" + g.id + ")",
            })),
          },
        ]}
      />
      {form && (
        <>
          <Switch
            mt="md"
            label="Enable AI for this conversation"
            checked={form.ai_enabled}
            disabled={saving || saved?.opted_out}
            onChange={(e) =>
              setForm({ ...form, ai_enabled: e.currentTarget.checked })
            }
          />
          {saved?.opted_out && (
            <Alert mt="md" color="yellow">
              This contact has opted out. Restore the contact in Inbox before
              enabling AI.
            </Alert>
          )}
          <Select
            mt="md"
            label="Mode"
            value={form.ai_mode}
            allowDeselect={false}
            disabled={saving}
            data={[
              { value: "immediate", label: "Immediate — on incoming messages" },
              { value: "scheduled", label: "Scheduled — check periodically" },
            ]}
            onChange={(value) => setForm({ ...form, ai_mode: value })}
          />
          {form.ai_mode === "scheduled" && (
            <NumberInput
              mt="md"
              label="Check every (minutes)"
              description="1 = every minute. AI may skip sending when conditions are not met."
              min={1}
              max={10080}
              allowDecimal={false}
              value={form.ai_interval_minutes}
              disabled={saving}
              onChange={(value) =>
                setForm({ ...form, ai_interval_minutes: value })
              }
            />
          )}
          <Textarea
            mt="md"
            label="Instructions & conditions"
            minRows={6}
            maxLength={12000}
            value={form.ai_instructions}
            disabled={saving}
            placeholder="For example: if a question has been unanswered for 5 minutes, help with it. Otherwise stay silent."
            description="Added to global instructions. Define when to write, when to stay silent, and whether repeated reminders are allowed. Include a timezone for time-specific rules."
            onChange={(e) =>
              setForm({ ...form, ai_instructions: e.target.value })
            }
          />
          <div className="row" style={{ marginTop: 16 }}>
            <Button
              loading={saving}
              disabled={loading || !Number.isInteger(form.ai_interval_minutes)}
              onClick={save}
            >
              Save conversation settings
            </Button>
            <Button
              variant="subtle"
              disabled={saving || loading}
              onClick={() => setReload((v) => v + 1)}
            >
              Reload saved settings & status
            </Button>
          </div>
          {saved?.ai_next_run_at &&
            form.ai_mode === "scheduled" &&
            saved.ai_enabled &&
            masterEnabled && (
              <p className="muted">
                Next check: {new Date(saved.ai_next_run_at).toLocaleString()}
              </p>
            )}
          {saved?.ai_last_result && (
            <p role="status">
              <Badge
                color={saved.ai_last_result.status === "sent" ? "teal" : "gray"}
              >
                {saved.ai_last_result.status}
              </Badge>{" "}
              {saved.ai_last_result.reason}
              {" · "}
              {new Date(saved.ai_last_run_at).toLocaleString()}
            </p>
          )}
          <p className="muted">
            The server must stay running. Checks use OpenAI API credits even
            when no message is sent. Missed checks are coalesced into one check
            after restart.
          </p>
        </>
      )}
    </section>
  );
}
