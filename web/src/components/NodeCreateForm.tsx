import {
  Badge,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  Grid,
  Input,
  Select,
  Stack,
  Textarea
} from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import type { CreateNodePayload, CreateNodeTier, NodeDependencyRef, NodeTier, TaskStatus } from "../api/types";
import { NodeDependencyPicker, type DependencyPickerCandidate } from "./NodeDependencyPicker";

const AI_COMMAND_OTHER = "__other__";

const ALLOWED_PARENT_TIERS: Record<CreateNodeTier, NodeTier[]> = {
  epoch: [],
  phase: ["epoch"],
  plan: ["epoch", "phase"],
  task: ["phase", "plan"]
};

type NodeOption = {
  id: string;
  title: string;
  tier: NodeTier;
  status: TaskStatus;
  isBlocked: boolean;
  unresolvedDependencyCount?: number;
};

type NodeCreateFormProps = {
  aiCommandOptions: string[];
  nodeOptions: NodeOption[];
  presetTier: CreateNodeTier;
  submitLabel: string;
  submitColorScheme: string;
  submitting: boolean;
  helperText?: string;
  onCreate: (payload: CreateNodePayload) => Promise<void>;
};

export function NodeCreateForm(props: NodeCreateFormProps) {
  const { aiCommandOptions, nodeOptions, presetTier, submitLabel, submitColorScheme, submitting, helperText, onCreate } = props;
  const [title, setTitle] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [nodeTier, setNodeTier] = useState<CreateNodeTier>(presetTier);
  const [autoMerge, setAutoMerge] = useState(false);
  const [parentNodeId, setParentNodeId] = useState("");
  const [dependencyNodeRefs, setDependencyNodeRefs] = useState<NodeDependencyRef[]>([]);
  const [aiCommandSelection, setAiCommandSelection] = useState(aiCommandOptions[0] || "codex --yolo {prompt}");
  const [aiCommandOverride, setAiCommandOverride] = useState("");

  const optionById = useMemo(() => new Map(nodeOptions.map((option) => [option.id, option])), [nodeOptions]);

  const parentOptions = useMemo(() => {
    const allowedTiers = new Set(ALLOWED_PARENT_TIERS[nodeTier]);
    return nodeOptions.filter((option) => allowedTiers.has(option.tier));
  }, [nodeOptions, nodeTier]);

  const canCreate = useMemo(() => {
    const selectedAiCommand = aiCommandSelection === AI_COMMAND_OTHER ? aiCommandOverride.trim() : aiCommandSelection;
    if (!selectedAiCommand) return false;
    return title.trim().length >= 2 && taskPrompt.trim().length > 0;
  }, [aiCommandOverride, aiCommandSelection, taskPrompt, title]);

  useEffect(() => {
    setNodeTier(presetTier);
  }, [presetTier]);

  useEffect(() => {
    if (nodeTier === "epoch") {
      setParentNodeId("");
      return;
    }
    const allowedParentIds = new Set(parentOptions.map((option) => option.id));
    if (parentNodeId && !allowedParentIds.has(parentNodeId)) {
      setParentNodeId("");
    }
  }, [nodeTier, parentNodeId, parentOptions]);

  useEffect(() => {
    if (nodeTier !== "task") {
      setAutoMerge(false);
    }
  }, [nodeTier]);

  useEffect(() => {
    const nextDefault = aiCommandOptions[0] || "codex --yolo {prompt}";
    if (!aiCommandOptions.includes(aiCommandSelection) && aiCommandSelection !== AI_COMMAND_OTHER) {
      setAiCommandSelection(nextDefault);
    }
  }, [aiCommandOptions, aiCommandSelection]);

  useEffect(() => {
    const selectableIds = new Set(nodeOptions.map((option) => option.id));
    setDependencyNodeRefs((prev) => {
      const next = prev.filter((ref) => selectableIds.has(ref.id));
      return next.length === prev.length ? prev : next;
    });
  }, [nodeOptions]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    const aiCommand = aiCommandSelection === AI_COMMAND_OTHER ? aiCommandOverride.trim() : aiCommandSelection;
    if (!aiCommand) {
      return;
    }

    const resolvedDependencyNodeRefs: NodeDependencyRef[] = dependencyNodeRefs.flatMap((ref) => {
      const option = optionById.get(ref.id);
      if (!option) return [];
      return [
        {
          id: ref.id,
          tier: ref.tier ?? option.tier,
          reason: ref.reason?.trim() || undefined
        }
      ];
    });

    await onCreate({
      title: title.trim(),
      taskPrompt: taskPrompt.trim(),
      nodeTier,
      aiCommand,
      autoMerge: nodeTier === "task" ? autoMerge : undefined,
      parentNodeId: parentNodeId || undefined,
      dependencyNodeRefs: resolvedDependencyNodeRefs
    });

    setTitle("");
    setTaskPrompt("");
    setNodeTier(presetTier);
    setAutoMerge(false);
    setParentNodeId("");
    setDependencyNodeRefs([]);
    setAiCommandSelection(aiCommandOptions[0] || "codex --yolo {prompt}");
    setAiCommandOverride("");
  }

  const dependencyCandidates: DependencyPickerCandidate[] = nodeOptions;

  return (
    <form onSubmit={onSubmit}>
      <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={4}>
        <FormControl isRequired>
          <FormLabel>Title</FormLabel>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </FormControl>
        <FormControl isRequired>
          <FormLabel>Node Tier</FormLabel>
          <Select value={nodeTier} onChange={(event) => setNodeTier(event.target.value as CreateNodeTier)}>
            <option value="epoch">epoch</option>
            <option value="phase">phase</option>
            <option value="plan">plan</option>
            <option value="task">task</option>
          </Select>
        </FormControl>
        <FormControl isRequired>
          <FormLabel>AI Command</FormLabel>
          <Stack spacing={2}>
            <Select
              value={aiCommandSelection}
              onChange={(event) => {
                const selected = event.target.value;
                setAiCommandSelection(selected);
                if (selected !== AI_COMMAND_OTHER) {
                  setAiCommandOverride("");
                }
              }}
            >
              {aiCommandOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              <option value={AI_COMMAND_OTHER}>Other</option>
            </Select>
            {aiCommandSelection === AI_COMMAND_OTHER && (
              <Input
                placeholder="Enter custom AI command"
                value={aiCommandOverride}
                onChange={(event) => setAiCommandOverride(event.target.value)}
              />
            )}
          </Stack>
        </FormControl>
        <FormControl isDisabled={nodeTier === "epoch"}>
          <FormLabel>Parent Node</FormLabel>
          <Select
            placeholder={nodeTier === "epoch" ? "Epoch nodes are top-level roots" : "No parent (root node)"}
            value={parentNodeId}
            onChange={(event) => setParentNodeId(event.target.value)}
          >
            {parentOptions.map((option) => (
              <option key={option.id} value={option.id}>
                [{option.tier}] {option.title}
              </option>
            ))}
          </Select>
        </FormControl>
        <Box>
          <NodeDependencyPicker
            value={dependencyNodeRefs}
            candidates={dependencyCandidates}
            onChange={setDependencyNodeRefs}
            helperText="Dependencies can reference any node tier with an optional reason."
          />
        </Box>
        <FormControl>
          <FormLabel>Automation</FormLabel>
          <Checkbox isChecked={autoMerge} isDisabled={nodeTier !== "task"} onChange={(event) => setAutoMerge(event.target.checked)}>
            Auto-merge when waiting for input
          </Checkbox>
        </FormControl>
        <FormControl gridColumn={{ md: "1 / span 2" }} isRequired>
          <FormLabel>Prompt</FormLabel>
          <Textarea rows={6} value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} />
        </FormControl>
      </Grid>
      {helperText && (
        <Box mt={3}>
          <Badge colorScheme="gray">{helperText}</Badge>
        </Box>
      )}
      <Button mt={4} colorScheme={submitColorScheme} type="submit" isLoading={submitting} isDisabled={!canCreate}>
        {submitLabel}
      </Button>
    </form>
  );
}
