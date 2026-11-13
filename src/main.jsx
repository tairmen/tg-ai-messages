import AiConversationSettings from "./AiConversationSettings.jsx";
import AuthGate from "./AuthGate.jsx";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MantineProvider,
  Button,
  TextInput,
  Textarea,
  Switch,
  Badge,
  Modal,
  MultiSelect,
  Alert,
  Avatar,
  Loader,
  FileButton,
} from "@mantine/core";
import {
  IconSend,
  IconMessages,
  IconUsers,
  IconSpeakerphone,
  IconSparkles,
  IconSettings,
  IconArrowUpRight,
  IconPlus,
  IconUpload,
  IconSearch,
  IconBolt,
  IconCheck,
  IconRefresh,
} from "@tabler/icons-react";
import Papa from "papaparse";
import "@mantine/core/styles.css";
import "./style.css";
let csrf = "";
async function api(url, method = "GET", body) {
  const r = await fetch("/api" + url, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Token": csrf },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event("relay-auth-expired"));
    throw new Error(data.error || "Request failed");
  }
  return data;
}
function App({ onLogout }) {
  const [page, setPage] = useState("Overview"),
    [health, setHealth] = useState(null),
    [contacts, setContacts] = useState([]),
    [campaigns, setCampaigns] = useState([]),
    [config, setConfig] = useState(null),
    [savedMasterEnabled, setSavedMasterEnabled] = useState(false),
    [mcpConnections, setMcpConnections] = useState([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [add, setAdd] = useState(false),
    [form, setForm] = useState({ name: "", phone: "" }),
    [search, setSearch] = useState(""),
    [active, setActive] = useState(null),
    [messages, setMessages] = useState([]),
    [reply, setReply] = useState(""),
    [campaign, setCampaign] = useState({
      name: "",
      body: "",
      recipient_ids: [],
    }),
    [confirm, setConfirm] = useState(null);
  async function refresh() {
    const h = await api("/health");
    csrf = h.token;
    setHealth(h);
    if (h.database) {
      const [c, k, s, connections] = await Promise.all([
        api("/contacts"),
        api("/campaigns"),
        api("/settings"),
        api("/mcp/connections"),
      ]);
      setMcpConnections(connections);
      setContacts(c);
      setCampaigns(k);
      setConfig((prev) => prev || s);
      setSavedMasterEnabled(s.enabled);
    }
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 6000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!active) {
      setMessages([]);
      return;
    }
    let live = true;
    const load = () =>
      api(`/contacts/${active}/messages`)
        .then((m) => {
          if (live) setMessages(m);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active]);
  async function action(fn, message) {
    setPending(true);
    setError("");
    try {
      await fn();
      if (message) setNotice(message);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const current = contacts.find((c) => c.id === active);
  const nav = [
    ["Overview", IconBolt],
    ["Inbox", IconMessages],
    ["Contacts", IconUsers],
    ["Campaigns", IconSpeakerphone],
    ["AI assistant", IconSparkles],
    ["Settings", IconSettings],
  ];
  const filtered = contacts.filter((c) =>
    (c.name + " " + c.phone).toLowerCase().includes(search.toLowerCase()),
  );
  async function importFile(file) {
    if (!file) return;
    await action(async () => {
      const parsed = Papa.parse(await file.text(), {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
      });
      if (parsed.errors.length)
        throw new Error("Invalid CSV. Use name,phone columns.");
      await api("/contacts/import", "POST", {
        contacts: parsed.data.map((r) => ({
          name: r.name || "",
          phone: r.phone || "",
        })),
      });
    }, "Contacts imported");
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Overview");
          }}
        >
          <span className="brand-icon">
            <IconSend size={23} />
          </span>
          relay<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <Avatar color="teal" radius="md" size={34}>
            T
          </Avatar>
          <div>
            <strong>Telegram workspace</strong>
            <small>Local admin · v0.1</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(([name, Icon]) => (
            <button
              key={name}
              aria-label={name}
              title={name}
              className={page === name ? "selected" : ""}
              onClick={() => {
                setPage(name);
                setSearch("");
              }}
            >
              <Icon size={20} />
              <span>{name}</span>
              {name === "Inbox" && (
                <span className="nav-count">
                  {contacts.filter((c) => c.last_message).length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="assistant-card">
            <IconSparkles size={20} />
            <strong>Your voice. Less busywork.</strong>
            <p>
              Give your assistant context, then choose which conversations it
              handles.
            </p>
            <button onClick={() => setPage("AI assistant")}>
              Configure assistant <IconArrowUpRight size={16} />
            </button>
          </div>
          <div className="local-label">
            <span className="dot green" /> Running on your computer
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Workspace <span>/</span> <b>{page}</b>
          </div>
          <div className="header-right">
            <Button size="xs" variant="subtle" color="gray" onClick={onLogout}>
              Log out
            </Button>
            <Badge
              variant="light"
              color={health?.telegram.connected ? "teal" : "gray"}
            >
              {health?.telegram.connected
                ? "Account connected"
                : "Account offline"}
            </Badge>
            <Avatar size={32} color="dark" radius="xl">
              TA
            </Avatar>
          </div>
        </header>
        <div className="content">
          {error && (
            <Alert
              color="red"
              title="Something needs attention"
              withCloseButton
              onClose={() => setError("")}
              mb="md"
            >
              {error}
            </Alert>
          )}
          {notice && (
            <Alert
              color="teal"
              withCloseButton
              onClose={() => setNotice("")}
              mb="md"
            >
              {notice}
            </Alert>
          )}
          {health?.telegram.error && (
            <Alert color="orange" mb="md">
              {health.telegram.error}
            </Alert>
          )}
          {health && !health.database && (
            <Alert color="orange" mb="md">
              {health.databaseError}
            </Alert>
          )}
          {page === "Overview" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR MESSAGING, IN ONE PLACE</div>
                  <h1>A little closer to your customers.</h1>
                  <p>
                    Start conversations, follow up, and let your assistant take
                    care of the details.
                  </p>
                </div>
                <Button
                  leftSection={<IconPlus size={17} />}
                  onClick={() => setPage("Campaigns")}
                >
                  New campaign
                </Button>
              </div>
              <div className="stats">
                {[
                  [
                    "Contacts",
                    contacts.length,
                    "People in your workspace",
                    IconUsers,
                  ],
                  [
                    "Conversations",
                    contacts.filter((c) => c.last_message).length,
                    "Your customer conversations",
                    IconMessages,
                  ],
                  [
                    "Campaigns",
                    campaigns.length,
                    "Drafts and sent campaigns",
                    IconSpeakerphone,
                  ],
                  [
                    "AI enabled",
                    contacts.filter((c) => c.ai_enabled).length,
                    config?.enabled
                      ? "Assistant is active"
                      : "Assistant is paused",
                    IconSparkles,
                  ],
                ].map(([label, value, sub, Icon]) => (
                  <div className="stat card" key={label}>
                    <div className="stat-top">
                      {label}
                      <Icon size={19} />
                    </div>
                    <div className="stat-value">
                      {value}
                      <span>
                        {label === "AI enabled" ? (
                          <Badge
                            color={config?.enabled ? "teal" : "gray"}
                            variant="light"
                          >
                            {config?.enabled ? "Active" : "Paused"}
                          </Badge>
                        ) : null}
                      </span>
                    </div>
                    <small>{sub}</small>
                  </div>
                ))}
              </div>
              <div className="overview-grid">
                <section className="card get-started">
                  <div className="section-top">
                    <h2>Ready when you are</h2>
                    <Badge color="teal" variant="light">
                      Getting started
                    </Badge>
                  </div>
                  <p className="muted">
                    Three steps to your first conversation.
                  </p>
                  {[
                    [
                      health?.database,
                      "01",
                      "Connect your workspace",
                      "PostgreSQL stores your contacts, conversations, and settings.",
                      "Settings",
                    ],
                    [
                      health?.telegram.connected,
                      "02",
                      "Connect Telegram",
                      "Sign in once using the local terminal flow.",
                      "Settings",
                    ],
                    [
                      contacts.length > 0,
                      "03",
                      "Bring your customers along",
                      "Add a contact or import a CSV with names and phone numbers.",
                      "Contacts",
                    ],
                  ].map(([done, n, title, description, target]) => (
                    <button
                      className="setup-step"
                      onClick={() => setPage(target)}
                      key={n}
                    >
                      <span
                        className={"step-number " + (done ? "complete" : "")}
                      >
                        {done ? <IconCheck size={17} /> : n}
                      </span>
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                      <IconArrowUpRight size={18} />
                    </button>
                  ))}
                </section>
                <section className="feature-card">
                  <div className="feature-orbit">
                    <IconSparkles size={34} />
                  </div>
                  <Badge color="teal" variant="light">
                    A HELPING HAND
                  </Badge>
                  <h2>
                    Good conversations.
                    <br />
                    Even when you're busy.
                  </h2>
                  <p>
                    Set your tone, add your business knowledge, and keep control
                    with per-contact AI settings.
                  </p>
                  <Button
                    color="dark"
                    rightSection={<IconArrowUpRight size={17} />}
                    onClick={() => setPage("AI assistant")}
                  >
                    Make it your own
                  </Button>
                </section>
              </div>
              <section className="card recent">
                <div className="section-top">
                  <h2>Recent conversations</h2>
                  <Button
                    variant="subtle"
                    color="dark"
                    size="xs"
                    onClick={() => setPage("Inbox")}
                  >
                    View inbox <IconArrowUpRight size={15} />
                  </Button>
                </div>
                {contacts
                  .filter((c) => c.last_message)
                  .slice(0, 4)
                  .map((c) => (
                    <button
                      className="recent-row"
                      key={c.id}
                      onClick={() => {
                        setActive(c.id);
                        setPage("Inbox");
                      }}
                    >
                      <Avatar radius="xl" color="teal">
                        {c.name.slice(0, 2).toUpperCase()}
                      </Avatar>
                      <span>
                        <strong>{c.name}</strong>
                        <small>{c.last_message}</small>
                      </span>
                      <IconArrowUpRight size={18} />
                    </button>
                  ))}
                {!contacts.some((c) => c.last_message) && (
                  <Empty
                    icon={IconMessages}
                    title="Your next conversation starts here"
                    text="Add your contacts and send a first message to see it in your inbox."
                    action={
                      <Button
                        variant="light"
                        onClick={() => setPage("Contacts")}
                      >
                        Add contacts
                      </Button>
                    }
                  />
                )}
              </section>
            </>
          )}
          {page === "Contacts" && (
            <>
              <Heading
                title="Your people."
                text="A small list. A more personal conversation."
                action={
                  <div className="row">
                    <FileButton onChange={importFile} accept=".csv">
                      <Button
                        variant="default"
                        leftSection={<IconUpload size={17} />}
                        loading={pending}
                      >
                        Import CSV
                      </Button>
                    </FileButton>
                    <Button
                      leftSection={<IconPlus size={17} />}
                      onClick={() => setAdd(true)}
                    >
                      Add contact
                    </Button>
                  </div>
                }
              />
              <div className="card">
                <div className="table-toolbar">
                  <TextInput
                    aria-label="Search contacts"
                    placeholder="Search name or number"
                    leftSection={<IconSearch size={17} />}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <span className="muted">
                    {contacts.length} contacts · CSV columns: name,phone
                  </span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Phone number</th>
                        <th>Telegram</th>
                        <th>AI assistant</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <div className="row">
                              <Avatar radius="xl" color="teal" size={32}>
                                {c.name.slice(0, 1)}
                              </Avatar>
                              <strong>{c.name}</strong>
                            </div>
                          </td>
                          <td>{c.phone}</td>
                          <td>
                            <Badge
                              color={c.telegram_id ? "teal" : "gray"}
                              variant="light"
                            >
                              {c.telegram_id ? "Matched" : "Not matched yet"}
                            </Badge>
                          </td>
                          <td>
                            <Switch
                              aria-label={"Enable AI for " + c.name}
                              checked={c.ai_enabled}
                              disabled={pending || c.opted_out}
                              onChange={() =>
                                action(() =>
                                  api("/contacts/" + c.id, "PATCH", {
                                    ai_enabled: !c.ai_enabled,
                                    opted_out: c.opted_out,
                                  }),
                                )
                              }
                            />
                          </td>
                          <td>
                            {c.opted_out ? (
                              <Badge color="red">Opted out</Badge>
                            ) : (
                              <Badge variant="light" color="teal">
                                Active
                              </Badge>
                            )}
                          </td>
                          <td>
                            <Button
                              size="xs"
                              variant="subtle"
                              onClick={() => {
                                setActive(c.id);
                                setPage("Inbox");
                              }}
                            >
                              Open chat
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!filtered.length && (
                  <Empty
                    icon={IconUsers}
                    title="Make your first connection"
                    text="Add a customer manually or upload a CSV with name and phone columns."
                    action={
                      <Button variant="light" onClick={() => setAdd(true)}>
                        Add contact
                      </Button>
                    }
                  />
                )}
              </div>
            </>
          )}
          {page === "Inbox" && (
            <>
              <Heading
                title="Keep the conversation going."
                text="Your customer conversations, with you in control."
              />
              <div className="inbox card">
                <div className="chat-list">
                  <TextInput
                    aria-label="Search conversations"
                    placeholder="Find a conversation"
                    leftSection={<IconSearch size={16} />}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {filtered.map((c) => (
                    <button
                      key={c.id}
                      className={
                        "chat-item " + (active === c.id ? "active" : "")
                      }
                      onClick={() => {
                        setActive(c.id);
                        setReply("");
                      }}
                    >
                      <Avatar color="teal" radius="xl">
                        {c.name.slice(0, 2)}
                      </Avatar>
                      <span>
                        <strong>{c.name}</strong>
                        <small>{c.last_message || c.phone}</small>
                      </span>
                      {c.ai_enabled && <IconSparkles size={15} />}
                    </button>
                  ))}
                  {!filtered.length && (
                    <p className="muted">
                      Add contacts to start a conversation.
                    </p>
                  )}
                </div>
                <div className="chat-pane">
                  {current ? (
                    <>
                      <div className="chat-header">
                        <div>
                          <strong>{current.name}</strong>
                          <small>{current.phone}</small>
                        </div>
                        <div className="row">
                          <Switch
                            label="AI replies"
                            checked={current.ai_enabled}
                            disabled={pending || current.opted_out}
                            onChange={() =>
                              action(() =>
                                api("/contacts/" + current.id, "PATCH", {
                                  ai_enabled: !current.ai_enabled,
                                  opted_out: current.opted_out,
                                }),
                              )
                            }
                          />
                          <Button
                            size="xs"
                            color={current.opted_out ? "teal" : "gray"}
                            variant="light"
                            disabled={pending}
                            onClick={() =>
                              action(() =>
                                api("/contacts/" + current.id, "PATCH", {
                                  ai_enabled: false,
                                  opted_out: !current.opted_out,
                                }),
                              )
                            }
                          >
                            {current.opted_out ? "Restore contact" : "Opt out"}
                          </Button>
                        </div>
                      </div>
                      <div className="messages">
                        {messages.length ? (
                          messages.map((m) => (
                            <div
                              key={m.id}
                              className={
                                "message " +
                                (m.direction === "out" ? "out" : "")
                              }
                            >
                              <div>{m.body}</div>
                              <small>
                                {m.source === "ai" ? "AI · " : ""}
                                {new Date(m.created_at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </small>
                            </div>
                          ))
                        ) : (
                          <Empty
                            icon={IconMessages}
                            title="Say hello"
                            text="Send your first message below."
                          />
                        )}
                      </div>
                      <div className="composer">
                        <Textarea
                          aria-label="Message"
                          placeholder={
                            current.opted_out
                              ? "This contact has opted out"
                              : "Write a thoughtful reply…"
                          }
                          minRows={2}
                          maxRows={6}
                          autosize
                          value={reply}
                          onChange={(e) => setReply(e.target.value)}
                          disabled={current.opted_out}
                        />
                        <div className="composer-actions">
                          <Button
                            variant="subtle"
                            leftSection={<IconSparkles size={16} />}
                            loading={pending}
                            disabled={
                              !messages.length ||
                              !health?.openai ||
                              current.opted_out
                            }
                            onClick={() =>
                              action(async () =>
                                setReply(
                                  (
                                    await api(
                                      "/contacts/" + active + "/draft",
                                      "POST",
                                    )
                                  ).text,
                                ),
                              )
                            }
                          >
                            Draft with AI
                          </Button>
                          <Button
                            leftSection={<IconSend size={16} />}
                            loading={pending}
                            disabled={
                              !reply.trim() ||
                              !health?.telegram.connected ||
                              current.opted_out
                            }
                            onClick={() =>
                              setConfirm({
                                type: "message",
                                contactId: current.id,
                                name: current.name,
                                text: reply,
                              })
                            }
                          >
                            Send message
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <Empty
                      icon={IconMessages}
                      title="Every good conversation starts somewhere"
                      text="Choose a contact on the left to read or send messages."
                    />
                  )}
                </div>
              </div>
            </>
          )}
          {page === "Campaigns" && (
            <>
              <Heading
                title="Small campaigns. Real connections."
                text="Compose a personal message for up to 10 customers."
              />
              <div className="campaign-grid">
                <section className="card padded">
                  <h2>Create a campaign</h2>
                  <TextInput
                    label="Campaign name"
                    placeholder="November check-in"
                    value={campaign.name}
                    onChange={(e) =>
                      setCampaign({ ...campaign, name: e.target.value })
                    }
                  />
                  <MultiSelect
                    mt="md"
                    label="Recipients"
                    placeholder="Choose up to 10 contacts"
                    searchable
                    data={contacts
                      .filter((c) => !c.opted_out)
                      .map((c) => ({
                        value: String(c.id),
                        label: c.name + " · " + c.phone,
                      }))}
                    value={campaign.recipient_ids}
                    maxValues={10}
                    onChange={(recipient_ids) =>
                      setCampaign({ ...campaign, recipient_ids })
                    }
                  />
                  <Textarea
                    mt="md"
                    label="Your message"
                    description="Use {{name}} to personalize each message."
                    minRows={6}
                    maxLength={4000}
                    value={campaign.body}
                    onChange={(e) =>
                      setCampaign({ ...campaign, body: e.target.value })
                    }
                    placeholder="Hi {{name}}, just checking in…"
                  />
                  <div className="row spread" style={{ marginTop: 20 }}>
                    <small className="muted">
                      {campaign.recipient_ids.length}/10 recipients
                    </small>
                    <Button
                      loading={pending}
                      disabled={
                        !campaign.name.trim() ||
                        !campaign.body.trim() ||
                        !campaign.recipient_ids.length
                      }
                      onClick={() =>
                        action(async () => {
                          await api("/campaigns", "POST", {
                            ...campaign,
                            recipient_ids: campaign.recipient_ids.map(Number),
                          });
                          setCampaign({
                            name: "",
                            body: "",
                            recipient_ids: [],
                          });
                        }, "Campaign saved as a draft")
                      }
                    >
                      Save draft
                    </Button>
                  </div>
                </section>
                <section className="preview-panel">
                  <div className="eyebrow">MESSAGE PREVIEW</div>
                  <div className="phone-preview">
                    <div className="phone-heading">
                      <Avatar size={30} color="teal" radius="xl">
                        {health?.telegram.account?.name?.slice(0, 1) || "Y"}
                      </Avatar>
                      <strong>
                        {health?.telegram.account?.name || "Your account"}
                      </strong>
                    </div>
                    <div className="preview-bubble">
                      {campaign.body.replaceAll(
                        "{{name}}",
                        contacts.find(
                          (c) => String(c.id) === campaign.recipient_ids[0],
                        )?.name || "Alex",
                      ) || "Your message will appear here."}
                      <small>Just now ✓</small>
                    </div>
                  </div>
                  <p className="muted">
                    Messages are sent individually from your Telegram account. A
                    saved draft is reviewed before sending.
                  </p>
                </section>
              </div>
              <section className="card recent">
                <h2>Campaign history</h2>
                {!campaigns.length && (
                  <Empty
                    icon={IconSpeakerphone}
                    title="Your first campaign is waiting"
                    text="Save a draft above. You can review it before sending."
                  />
                )}
                {campaigns.map((c) => (
                  <div className="campaign-row" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>
                        {c.recipient_ids.length} recipients ·{" "}
                        {new Date(c.created_at).toLocaleDateString()}
                      </small>
                      <p>{c.body}</p>
                      {c.results.length > 0 && (
                        <small>
                          {c.results.filter((r) => r.status === "sent").length}{" "}
                          sent ·{" "}
                          {c.results.filter((r) => r.status !== "sent").length}{" "}
                          not sent{" "}
                          {c.results
                            .filter((r) => r.error)
                            .map((r) => " · #" + r.contact_id + ": " + r.error)
                            .join("")}
                        </small>
                      )}
                    </div>
                    <Badge
                      color={
                        c.status === "completed"
                          ? "teal"
                          : c.status === "draft"
                            ? "gray"
                            : "orange"
                      }
                    >
                      {c.status}
                    </Badge>
                    {c.status === "draft" && (
                      <Button
                        size="xs"
                        disabled={pending || !health?.telegram.connected}
                        onClick={() =>
                          setConfirm({ type: "campaign", campaign: c })
                        }
                      >
                        Review & send
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
          {page === "AI assistant" && (
            <>
              <Heading
                title="An assistant that sounds like you."
                text="Set the context. Define the boundaries. Keep the personal touch."
              />
              <div className="ai-grid">
                <section className="card padded">
                  {config ? (
                    <>
                      <div className="section-top">
                        <h2>Assistant instructions</h2>
                        <Badge color={config.enabled ? "teal" : "gray"}>
                          {config.enabled ? "Active" : "Paused"}
                        </Badge>
                      </div>
                      <Textarea
                        label="Business knowledge & tone"
                        description="Include your services, prices, working hours, FAQs, and when to hand off to a human."
                        minRows={13}
                        value={config.instructions}
                        onChange={(e) =>
                          setConfig({ ...config, instructions: e.target.value })
                        }
                      />
                      <TextInput
                        mt="md"
                        label="OpenAI model"
                        value={config.model}
                        onChange={(e) =>
                          setConfig({ ...config, model: e.target.value })
                        }
                      />
                      <div className="ai-toggle">
                        <div>
                          <strong>Automatic replies</strong>
                          <small>
                            Only for contacts and groups with AI enabled.
                          </small>
                        </div>
                        <Switch
                          aria-label="Automatic replies"
                          checked={config.enabled}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              enabled: e.currentTarget.checked,
                            })
                          }
                        />
                      </div>
                      <Button
                        loading={pending}
                        onClick={() =>
                          action(
                            () => api("/settings", "PUT", config),
                            "Assistant settings saved",
                          )
                        }
                      >
                        Save instructions
                      </Button>
                    </>
                  ) : (
                    <p className="muted">
                      Connect the database to configure your assistant.
                    </p>
                  )}
                </section>
                <div>
                  <section className="card padded">
                    <div className="icon-tile">
                      <IconSparkles />
                    </div>
                    <h2>You set the boundaries.</h2>
                    <p className="muted">
                      Automatic replies require both the master switch here and
                      the AI switch on each contact or group.
                    </p>
                    {[
                      [
                        "01",
                        "Start with a draft",
                        "Use Draft with AI in the inbox to review a response before sending.",
                      ],
                      [
                        "02",
                        "Give it the facts",
                        "Add the information customers need. Tell the assistant when to ask you for help.",
                      ],
                      [
                        "03",
                        "Keep an eye on replies",
                        "AI messages appear in your inbox. Pause any contact to take over.",
                      ],
                    ].map(([n, t, p]) => (
                      <div className="tip" key={n}>
                        <span>{n}</span>
                        <div>
                          <strong>{t}</strong>
                          <p>{p}</p>
                        </div>
                      </div>
                    ))}
                  </section>
                  <p className="muted footnote">
                    AI drafting and replies send conversation text to OpenAI and
                    use your API credits.
                  </p>
                </div>
              </div>
              <AiConversationSettings
                api={api}
                contacts={contacts}
                refreshContacts={refresh}
                masterEnabled={savedMasterEnabled}
              />
            </>
          )}
          {page === "Settings" && (
            <>
              <Heading
                title="Everything connected."
                text="A simple workspace, running on your own computer."
              />
              <div className="card padded settings-card">
                <h2>Connections</h2>
                {[
                  [
                    "PostgreSQL",
                    health?.database,
                    "Contacts, messages, campaigns, and AI settings.",
                  ],
                  [
                    "OpenAI",
                    health?.openai,
                    "API key is read from your local .env file.",
                  ],
                  [
                    "Telegram",
                    health?.telegram.connected,
                    health?.telegram.account?.name ||
                      "Connect a regular Telegram user account.",
                  ],
                ].map(([name, ok, text]) => (
                  <div className="connection" key={name}>
                    <span className={"connection-icon " + (ok ? "ok" : "")}>
                      <IconCheck size={20} />
                    </span>
                    <div>
                      <strong>{name}</strong>
                      <small>{text}</small>
                    </div>
                    <Badge variant="light" color={ok ? "teal" : "gray"}>
                      {ok ? "Configured" : "Not connected"}
                    </Badge>
                  </div>
                ))}
                {health?.mcp_url && (
                  <div className="login-help">
                    <h3>Chat with Relay through MCP</h3>
                    <p>
                      Add this server in your AI client and choose OAuth. Sign
                      in with your dashboard admin account and approve the
                      connection.
                    </p>
                    <TextInput
                      aria-label="MCP server URL"
                      value={health.mcp_url}
                      readOnly
                    />
                    <p>
                      Draft and preview campaigns in chat. Sending stays a
                      separate step.
                    </p>
                    <h3>Authorized connections</h3>
                    {mcpConnections.length ? (
                      mcpConnections.map((c) => (
                        <div className="connection" key={c.grant_id}>
                          <div>
                            <strong>MCP client</strong>
                            <small>{c.client_id.slice(0, 16)}…</small>
                          </div>
                          <Button
                            size="xs"
                            variant="light"
                            color="red"
                            loading={pending}
                            onClick={() =>
                              action(
                                () =>
                                  api(
                                    "/mcp/connections/" +
                                      encodeURIComponent(c.grant_id),
                                    "DELETE",
                                  ),
                                "MCP connection revoked",
                              )
                            }
                          >
                            Revoke
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p>No clients connected yet.</p>
                    )}
                  </div>
                )}
                <div className="login-help">
                  <h3>Connect your Telegram account</h3>
                  <p>Open a terminal in the project folder and run:</p>
                  <code>npm run telegram:login</code>
                  <p>
                    Enter your phone, login code, and two-step password there.
                    Then restart the app or click below.
                  </p>
                  <Button
                    variant="light"
                    leftSection={<IconRefresh size={16} />}
                    loading={pending}
                    onClick={() =>
                      action(
                        () => api("/telegram/connect", "POST"),
                        "Telegram connection checked",
                      )
                    }
                  >
                    Connect saved session
                  </Button>
                </div>
                <p className="muted footnote">
                  Credentials and the Telegram session stay on the service host.
                  Remote dashboard access requires the admin login; MCP clients
                  use scoped OAuth connections.
                </p>
              </div>
            </>
          )}
          {!health && (
            <div className="loading">
              <Loader color="teal" />
              <p>Connecting to your workspace…</p>
            </div>
          )}
          <footer>
            <span>relay · Your conversations, thoughtfully managed.</span>
            <span>
              Local workspace <span className="dot green" />
            </span>
          </footer>
        </div>
      </main>
      <Modal
        opened={add}
        onClose={() => setAdd(false)}
        title="Add a customer"
        centered
      >
        <TextInput
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextInput
          mt="md"
          label="Phone number"
          placeholder="+380…"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <Button
          fullWidth
          mt="lg"
          loading={pending}
          onClick={() =>
            action(async () => {
              await api("/contacts", "POST", form);
              setForm({ name: "", phone: "" });
              setAdd(false);
            }, "Contact added")
          }
        >
          Add contact
        </Button>
      </Modal>
      <Modal
        opened={!!confirm}
        onClose={() => !pending && setConfirm(null)}
        title="Review before sending"
        centered
      >
        <p>
          {confirm?.type === "campaign"
            ? `Send ${confirm.campaign.name} to ${confirm.campaign.recipient_ids.length} recipients?`
            : `Send this message to ${confirm?.name}?`}
        </p>
        <div className="confirm-message">
          {confirm?.type === "campaign" ? confirm.campaign.body : confirm?.text}
        </div>
        <Button
          fullWidth
          mt="lg"
          loading={pending}
          onClick={() =>
            action(async () => {
              if (confirm.type === "campaign")
                await api(
                  "/campaigns/" + confirm.campaign.id + "/send",
                  "POST",
                );
              else {
                await api("/contacts/" + confirm.contactId + "/send", "POST", {
                  body: confirm.text,
                });
                setReply("");
                setMessages(
                  await api("/contacts/" + confirm.contactId + "/messages"),
                );
              }
              setConfirm(null);
            }, "Sending finished; check results in the conversation or campaign history")
          }
        >
          Confirm & send
        </Button>
      </Modal>
    </div>
  );
}
function Heading({ title, text, action }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">TELEGRAM WORKSPACE</div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action}
    </div>
  );
}
function Empty({ icon: Icon, title, text, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={26} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <MantineProvider
    theme={{
      primaryColor: "teal",
      defaultRadius: "md",
      fontFamily: "Inter, Segoe UI, sans-serif",
      headings: { fontFamily: "Inter, Segoe UI, sans-serif" },
      components: { Button: { defaultProps: { fw: 600 } } },
    }}
  >
    <AuthGate>{(logout) => <App onLogout={logout} />}</AuthGate>
  </MantineProvider>,
);
