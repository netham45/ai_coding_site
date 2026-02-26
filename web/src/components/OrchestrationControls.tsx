import { useState } from "react";

export type StartTier = "epoch" | "phase" | "plan" | "task" | "exec";

type Props = {
  initialAutoMode?: boolean;
  initialAutoMerge?: boolean;
  onStartFromTier: (tier: StartTier) => void;
  onToggleAutoMode: (enabled: boolean) => void;
  onToggleAutoMerge: (enabled: boolean) => void;
};

const TIERS: StartTier[] = ["epoch", "phase", "plan", "task", "exec"];

export function OrchestrationControls(props: Props) {
  const [selectedTier, setSelectedTier] = useState<StartTier>("task");
  const [autoMode, setAutoMode] = useState<boolean>(props.initialAutoMode ?? true);
  const [autoMerge, setAutoMerge] = useState<boolean>(props.initialAutoMerge ?? true);

  return (
    <section aria-label="orchestration-controls">
      <h3>Orchestration Controls</h3>

      <label htmlFor="start-tier">Start Tier</label>
      <select
        id="start-tier"
        value={selectedTier}
        onChange={(event) => setSelectedTier(event.target.value as StartTier)}
      >
        {TIERS.map((tier) => (
          <option key={tier} value={tier}>{tier}</option>
        ))}
      </select>
      <button type="button" onClick={() => props.onStartFromTier(selectedTier)}>
        Start From Tier
      </button>

      <label>
        <input
          type="checkbox"
          checked={autoMode}
          onChange={(event) => {
            const enabled = event.target.checked;
            setAutoMode(enabled);
            props.onToggleAutoMode(enabled);
          }}
        />
        Auto Mode
      </label>

      <label>
        <input
          type="checkbox"
          checked={autoMerge}
          onChange={(event) => {
            const enabled = event.target.checked;
            setAutoMerge(enabled);
            props.onToggleAutoMerge(enabled);
          }}
        />
        Auto Merge
      </label>
    </section>
  );
}
