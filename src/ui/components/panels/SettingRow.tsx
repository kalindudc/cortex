// SettingRow — one setting from SETTINGS: its label, its meaning as one line
// of description, and a control of the setting's kind: a select, a segmented
// control or preview cards (both native radios), or a switch (choices[0] is
// off, choices[1] on). The control always has id="setting-<key>", and the
// row carries data-setting and data-value (the current choice). The only
// renderer of a setting, so the settings panel and the Backup panel show
// settings the same way.

import type { ComponentChildren, VNode } from "preact";

import type { SettingChoice, SettingSpec } from "../../state/settings.ts";
import { Icon } from "../Icon.tsx";

// A radiogroup of native radios, one label per choice holding its radio and
// `content` (the segmented control's text, or a card's preview and name).
function Radios({
  spec,
  current,
  optionClass,
  content,
}: {
  spec: SettingSpec;
  current: string;
  optionClass: string;
  content: (choice: SettingChoice, checked: boolean) => ComponentChildren;
}): VNode {
  const id = `setting-${spec.key}`;
  return (
    <div
      role="radiogroup"
      aria-label={spec.label}
      aria-describedby={`${id}-meaning`}
      id={id}
      class={`setting-${spec.control}`}
    >
      {spec.choices.map(c => {
        const checked = c.value === current;
        return (
          <label class={optionClass} data-value={c.value} key={c.value}>
            <input type="radio" name={id} value={c.value} checked={checked} onChange={() => spec.set(c.value)} />
            {content(c, checked)}
          </label>
        );
      })}
    </div>
  );
}

function Control({ spec, current }: { spec: SettingSpec; current: string }): VNode {
  const id = `setting-${spec.key}`;
  if (spec.control === "segmented") {
    return <Radios spec={spec} current={current} optionClass="seg-option" content={c => <span>{c.label}</span>} />;
  }
  if (spec.control === "cards") {
    return (
      <Radios
        spec={spec}
        current={current}
        optionClass="theme-card"
        content={(c, checked) => (
          <>
            <span class="theme-preview" aria-hidden="true">
              <i class="theme-preview-side"></i>
              <i class="theme-preview-lines">
                <i></i>
                <i></i>
                <i></i>
              </i>
            </span>
            <span class="theme-name">
              {c.label}
              {checked ? <Icon name="check" size={12} /> : null}
            </span>
          </>
        )}
      />
    );
  }
  if (spec.control === "switch") {
    const [off, on] = spec.choices;
    const isOn = current === on.value;
    return (
      <button
        type="button"
        role="switch"
        id={id}
        class="setting-switch"
        aria-checked={isOn ? "true" : "false"}
        aria-label={spec.label}
        aria-describedby={`${id}-meaning`}
        onClick={() => spec.set(isOn ? off.value : on.value)}
      >
        <span class="setting-switch-thumb" aria-hidden="true"></span>
      </button>
    );
  }
  return (
    <select
      id={id}
      class="setting-select"
      value={current}
      aria-describedby={`${id}-meaning`}
      onChange={e => spec.set((e.currentTarget as HTMLSelectElement).value)}
    >
      {spec.choices.map(c => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

export function SettingRow({ spec }: { spec: SettingSpec }): VNode {
  const current = spec.current();
  const id = `setting-${spec.key}`;
  return (
    <div class={`setting-row setting-row-${spec.control}`} data-setting={spec.key} data-value={current}>
      <div class="setting-label">
        {spec.control === "select" ? (
          <label class="setting-name" for={id}>
            {spec.label}
          </label>
        ) : (
          <span class="setting-name">{spec.label}</span>
        )}
        <span class="setting-meaning" id={`${id}-meaning`}>
          {spec.meaning}
        </span>
      </div>
      <Control spec={spec} current={current} />
    </div>
  );
}
