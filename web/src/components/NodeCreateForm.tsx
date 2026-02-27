import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  Input,
  Select,
  Stack,
  Text,
  Textarea
} from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import type { CreateNodePayload, CreateNodeTier, NodeTier, TaskStatus } from "../api/types";

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
  const [autoMerge, setAutoMerge] = useState(true);
  const [autoMergeOnComplete, setAutoMergeOnComplete] = useState(true);
  const [parentNodeId, setParentNodeId] = useState("");
  const [dependencySelections, setDependencySelections] = useState<string[]>([""]);
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
    const nextDefault = aiCommandOptions[0] || "codex --yolo {prompt}";
    if (!aiCommandOptions.includes(aiCommandSelection) && aiCommandSelection !== AI_COMMAND_OTHER) {
      setAiCommandSelection(nextDefault);
    }
  }, [aiCommandOptions, aiCommandSelection]);

  useEffect(() => {
    const selectableIds = new Set(nodeOptions.map((option) => option.id));
    setDependencySelections((prev) => {
      const next = prev.map((id) => (id && selectableIds.has(id) ? id : ""));
      const changed = next.length !== prev.length || next.some((id, index) => id !== prev[index]);
      return changed ? next : prev;
    });
  }, [nodeOptions]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    const aiCommand = aiCommandSelection === AI_COMMAND_OTHER ? aiCommandOverride.trim() : aiCommandSelection;
    if (!aiCommand) {
      return;
    }

    const uniqueDependencyIds = [...new Set(dependencySelections.filter(Boolean))];
    const dependencyNodeRefs = uniqueDependencyIds
      .map((id) => optionById.get(id))
      .filter((option): option is NodeOption => Boolean(option))
      .map((option) => ({ id: option.id, tier: option.tier }));

    await onCreate({
      title: title.trim(),
      taskPrompt: taskPrompt.trim(),
      nodeTier,
      aiCommand,
      autoMerge,
      autoMergeOnComplete: nodeTier === "task" ? undefined : autoMergeOnComplete,
      parentNodeId: parentNodeId || undefined,
      dependencyNodeRefs
    });

    setTitle("");
    setTaskPrompt("");
    setNodeTier(presetTier);
    setAutoMerge(true);
    setAutoMergeOnComplete(true);
    setParentNodeId("");
    setDependencySelections([""]);
    setAiCommandSelection(aiCommandOptions[0] || "codex --yolo {prompt}");
    setAiCommandOverride("");
  }

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
        <FormControl>
          <FormLabel>Dependencies</FormLabel>
          <Stack spacing={2}>
            {dependencySelections.map((selectedId, index) => (
              <Flex key={`dependency-${index}`} gap={2}>
                <Select
                  placeholder="Select dependency"
                  value={selectedId}
                  onChange={(event) => {
                    const selected = event.target.value;
                    setDependencySelections((prev) => prev.map((id, rowIndex) => (rowIndex === index ? selected : id)));
                  }}
                >
                  {nodeOptions.map((option) => {
                    const selectedElsewhere = dependencySelections.includes(option.id) && selectedId !== option.id;
                    return (
                      <option key={option.id} value={option.id} disabled={selectedElsewhere}>
                        [{option.tier}] {option.title} ({option.isBlocked ? "blocked" : option.status})
                      </option>
                    );
                  })}
                </Select>
                <Button type="button" size="sm" minW="40px" onClick={() => setDependencySelections((prev) => [...prev, ""])}>
                  +
                </Button>
                <Button
                  type="button"
                  size="sm"
                  minW="40px"
                  isDisabled={dependencySelections.length === 1}
                  onClick={() => {
                    setDependencySelections((prev) => {
                      if (prev.length === 1) return [""];
                      return prev.filter((_, rowIndex) => rowIndex !== index);
                    });
                  }}
                >
                  -
                </Button>
              </Flex>
            ))}
          </Stack>
          <Text mt={1} fontSize="sm" color="gray.600">
            Dependencies can reference any node tier.
          </Text>
        </FormControl>
        <FormControl>
          <FormLabel>Automation</FormLabel>
          <Stack spacing={2}>
            <Checkbox isChecked={autoMerge} onChange={(event) => setAutoMerge(event.target.checked)}>
              {nodeTier === "task" ? "Auto-merge this node" : "Auto-merge child execution nodes by default"}
            </Checkbox>
            {nodeTier !== "task" && (
              <Checkbox isChecked={autoMergeOnComplete} onChange={(event) => setAutoMergeOnComplete(event.target.checked)}>
                Auto-merge this node when complete
              </Checkbox>
            )}
          </Stack>
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
