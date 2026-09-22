import AgentDashboard from '../../../../components/agent-dashboard';
export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return <AgentDashboard agentId={agentId} />;
}
