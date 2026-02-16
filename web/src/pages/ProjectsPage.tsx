import {
  Badge,
  Box,
  Button,
  FormControl,
  FormLabel,
  Grid,
  Heading,
  Input,
  Link,
  Stack,
  Table,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  useToast
} from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { api } from "../api/client";
import type { Project } from "../api/types";

type ProjectsResponse = { projects: Project[] };

const initialForm = {
  name: "",
  repoUrl: "",
  projectPrompt: "",
  defaultBranch: "main"
};

function statusColor(status: Project["cloneStatus"]): string {
  if (status === "ready") return "green";
  if (status === "failed") return "red";
  if (status === "cloning") return "blue";
  return "gray";
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const canSubmit = useMemo(() => {
    return form.name.trim().length >= 2 && form.repoUrl.trim().length > 0;
  }, [form]);

  async function loadData() {
    const projectData = await api<ProjectsResponse>("/api/projects");
    setProjects(projectData.projects);
  }

  useEffect(() => {
    loadData().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load projects", description: error.message });
    });

    const interval = setInterval(() => {
      loadData().catch((error: Error) => {
        console.error("Failed to poll projects", error);
      });
    }, 3000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreateProject(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          repoUrl: form.repoUrl,
          projectPrompt: form.projectPrompt,
          defaultBranch: form.defaultBranch
        })
      });
      setForm(initialForm);
      await loadData();
      toast({ status: "success", title: "Project created" });
    } catch (error: any) {
      toast({ status: "error", title: "Create failed", description: error.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack spacing={8}>
      <Box bg="white" borderRadius="lg" p={6} boxShadow="sm">
        <Heading size="md" mb={4}>
          Create Project
        </Heading>
        <form onSubmit={onCreateProject}>
          <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={4}>
            <FormControl isRequired>
              <FormLabel>Name</FormLabel>
              <Input value={form.name} onChange={(e) => setForm((x) => ({ ...x, name: e.target.value }))} />
            </FormControl>
            <FormControl isRequired>
              <FormLabel>Repository URL</FormLabel>
              <Input value={form.repoUrl} onChange={(e) => setForm((x) => ({ ...x, repoUrl: e.target.value }))} />
            </FormControl>
            <FormControl>
              <FormLabel>Default Branch</FormLabel>
              <Input value={form.defaultBranch} onChange={(e) => setForm((x) => ({ ...x, defaultBranch: e.target.value }))} />
            </FormControl>
            <FormControl gridColumn={{ md: "1 / span 2" }}>
              <FormLabel>Project Prompt</FormLabel>
              <Textarea
                value={form.projectPrompt}
                onChange={(e) => setForm((x) => ({ ...x, projectPrompt: e.target.value }))}
                rows={4}
              />
            </FormControl>
          </Grid>
          <Button mt={4} type="submit" colorScheme="teal" isDisabled={!canSubmit} isLoading={loading}>
            Create Project
          </Button>
        </form>
      </Box>

      <Box bg="white" borderRadius="lg" p={6} boxShadow="sm">
        <Heading size="md" mb={4}>
          Projects
        </Heading>
        <Table variant="simple">
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Repository</Th>
              <Th>Status</Th>
              <Th>Error</Th>
            </Tr>
          </Thead>
          <Tbody>
            {projects.map((project) => (
              <Tr key={project.id}>
                <Td>
                  <Link as={RouterLink} to={`/projects/${project.id}`} color="teal.600" fontWeight="700">
                    {project.name}
                  </Link>
                  <Text fontSize="sm" color="gray.600">
                    {project.slug}
                  </Text>
                </Td>
                <Td maxW="420px">
                  <Text isTruncated>{project.repoUrl}</Text>
                </Td>
                <Td>
                  <Badge colorScheme={statusColor(project.cloneStatus)}>{project.cloneStatus}</Badge>
                </Td>
                <Td>
                  <Text color="red.600" fontSize="sm">
                    {project.cloneError ?? "-"}
                  </Text>
                </Td>
              </Tr>
            ))}
            {!projects.length && (
              <Tr>
                <Td colSpan={4}>
                  <Text color="gray.600">No projects yet.</Text>
                </Td>
              </Tr>
            )}
          </Tbody>
        </Table>
      </Box>
    </Stack>
  );
}
