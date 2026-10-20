// AgentsPanel — the Agent tools view (no list column): whether the skills,
// the pi extension and the bb plugin match this cortex, with Check again,
// Install, and Reset, which asks first (ModalRoot's confirm-agents-reset).
// It checks each time it opens. Main runs `cortex agents <action> --json`
// for every action (state/agents.ts), so the panel only shows the answers.

import type { VNode } from "preact";
import { useEffect } from "preact/hooks";

import type { AgentsStatus, BbStatus, FilesStatus } from "../../../lib/agentTools.ts";
import { plural } from "../../../lib/format.ts";
import {
  agentsBusy,
  agentsCheckError,
  agentsOutcome,
  agentsStatus,
  checkAgents,
  installAgents,
} from "../../state/agents.ts";
import { modal } from "../../state/signals.ts";
import { Icon } from "../Icon.tsx";

type Shown = { label: string; tone: "ok" | "warn" | "off" };

const FILE_STATE: Record<FilesStatus["state"], Shown> = {
  installed: { label: "Up to date", tone: "ok" },
  outdated: { label: "Out of date", tone: "warn" },
  missing: { label: "Not installed", tone: "warn" },
};

const BB_STATE: Record<BbStatus["state"], Shown> = {
  ...FILE_STATE,
  foreign: { label: "Installed another way", tone: "warn" },
  skipped: { label: "Skipped", tone: "off" },
};

/** The CLI's messages quote commands in backticks; show those as code. */
export function CodeText({ text }: { text: string }): VNode {
  return <>{text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</>;
}

function StateBadge({ shown }: { shown: Shown }): VNode {
  return <span class={`agents-badge agents-${shown.tone}`}>{shown.label}</span>;
}

function FilesRow({ title, files }: { title: string; files: FilesStatus }): VNode {
  return (
    <div class="panel-row agents-row" data-agent-tool={title}>
      <div class="panel-row-label">
        <b>{title}</b>
        <span class="mono">{files.dir}</span>
        {files.state === "outdated" ? (
          <span>{plural(files.differs.length, "file")} missing or different from this version</span>
        ) : null}
      </div>
      <StateBadge shown={FILE_STATE[files.state]} />
    </div>
  );
}

function SkippedRow({ title, reason }: { title: string; reason: string }): VNode {
  return (
    <div class="panel-row agents-row" data-agent-tool={title}>
      <div class="panel-row-label">
        <b>{title}</b>
        <span>
          <CodeText text={reason} />
        </span>
      </div>
      <StateBadge shown={BB_STATE.skipped} />
    </div>
  );
}

function BbRow({ bb }: { bb: BbStatus }): VNode {
  const plugin = bb.plugin;
  return (
    <div class="panel-row agents-row" data-agent-tool="bb plugin">
      <div class="panel-row-label">
        <b>bb plugin</b>
        {bb.dir ? <span class="mono">{bb.dir}</span> : null}
        {bb.reason ? (
          <span class="agents-reason">
            <CodeText text={bb.reason} />
          </span>
        ) : null}
        {plugin ? (
          <span>
            bb reports it {plugin.status}
            {plugin.statusDetail ? `: ${plugin.statusDetail}` : ""}
            {plugin.cortexPath ? ` · runs cortex at ${plugin.cortexPath}` : ""}
          </span>
        ) : null}
      </div>
      <StateBadge shown={BB_STATE[bb.state]} />
    </div>
  );
}

/** How many tools install or reset would change. */
function pending(s: AgentsStatus): number {
  const files = [...s.skills, ...s.extensions].filter(f => f.state !== "installed").length;
  return files + (s.bb.state === "missing" || s.bb.state === "outdated" || s.bb.state === "foreign" ? 1 : 0);
}

function summary(s: AgentsStatus | null, error: string | null): { icon: string; title: string; detail: string } {
  if (s === null) {
    return error === null
      ? { icon: "bot", title: "Checking the agent tools…", detail: "" }
      : { icon: "x", title: "Could not check the agent tools", detail: error };
  }
  if (s.suggest === "none") {
    return { icon: "checkCircle", title: "Every agent tool is up to date", detail: `They match cortex ${s.version}.` };
  }
  if (s.suggest === "reset") {
    return {
      icon: "alertTriangle",
      title: "The bb plugin was installed another way",
      detail: "Reset replaces it with the plugin this cortex ships.",
    };
  }
  return {
    icon: "alertTriangle",
    title: `${plural(pending(s), "agent tool")} to install or update`,
    detail: `Install writes the versions cortex ${s.version} ships.`,
  };
}

export function AgentsPanel(): VNode {
  useEffect(() => {
    void checkAgents();
  }, []);
  const status = agentsStatus.value;
  const busy = agentsBusy.value;
  const checkError = agentsCheckError.value;
  const outcome = agentsOutcome.value;
  const head = summary(status, checkError);
  const writing = busy === "install" || busy === "reset";

  return (
    <section class="pane panel-view agents-panel" aria-label="Agent tools">
      <header class="panel-head">
        <div class="panel-crumb">
          <b>Agent tools</b>
        </div>
      </header>
      <div class="panel-body">
        <div class="panel-inner">
          <h1 class="panel-title">Agent tools</h1>
          <p class="panel-lede">
            Skills teach your agents how to use cortex, and the pi extension and bb plugin connect those harnesses to
            it. This compares the installed copies with this version of cortex.
          </p>

          <div class="panel-card">
            <div class="panel-row agents-summary">
              <span class="agents-icon" aria-hidden="true">
                <Icon name={head.icon} size={18} />
              </span>
              <div class="panel-row-label">
                <b class="agents-headline">{head.title}</b>
                {head.detail ? (
                  <span class="agents-detail">
                    <CodeText text={head.detail} />
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                class="btn"
                aria-label={busy === "status" ? "Checking" : "Check again"}
                disabled={busy !== null}
                onClick={() => {
                  agentsOutcome.value = null;
                  void checkAgents();
                }}
              >
                <Icon name="rotateCcw" />
                <span>{busy === "status" ? "Checking…" : "Check again"}</span>
              </button>
              <button
                type="button"
                class="btn btn-primary"
                aria-label={busy === "install" ? "Installing" : "Install"}
                disabled={busy !== null}
                onClick={() => void installAgents()}
              >
                <Icon name="download" />
                <span>{busy === "install" ? "Installing…" : "Install"}</span>
              </button>
            </div>
            {writing ? (
              <div class="panel-row agents-outcome" role="status">
                <span>
                  {busy === "install" ? "Installing" : "Resetting"}. The first bb plugin install runs npm, which can
                  take a few minutes.
                </span>
              </div>
            ) : outcome ? (
              <div class={`panel-row agents-outcome agents-outcome-${outcome.level}`} role="status">
                <Icon name={outcome.level === "info" ? "check" : "x"} />
                <span>
                  <CodeText text={outcome.text} />
                </span>
              </div>
            ) : null}
            {status !== null && checkError !== null ? (
              <div class="panel-row agents-check-error" role="status">
                <Icon name="x" />
                <span>The last check failed: {checkError}</span>
              </div>
            ) : null}
          </div>

          {status ? (
            <>
              <h2 class="panel-card-title">Skills</h2>
              <div class="panel-card">
                {status.skills.map(s => (
                  <FilesRow key={s.name} title={s.name} files={s} />
                ))}
              </div>

              <h2 class="panel-card-title">Harnesses</h2>
              <div class="panel-card">
                {status.extensions.map(e => (
                  <FilesRow key={e.name} title={`${e.name} extension`} files={e} />
                ))}
                {status.skipped.map(s => (
                  <SkippedRow key={s.name} title={`${s.name} extension`} reason={s.reason} />
                ))}
                <BbRow bb={status.bb} />
              </div>
            </>
          ) : null}

          <h2 class="panel-card-title">Reset</h2>
          <div class="panel-callout agents-reset">
            <p>
              Reset deletes the cortex skill, pi extension and bb plugin folders, then installs them again. It drops
              files an older version left behind and any hand-edits. The bb plugin is removed from bb first, which
              clears its settings.
            </p>
            <button
              type="button"
              class="btn btn-danger"
              disabled={busy !== null || status === null}
              onClick={() => (modal.value = { kind: "confirm-agents-reset" })}
            >
              <Icon name="trash" />
              <span>{busy === "reset" ? "Resetting…" : "Reset…"}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
