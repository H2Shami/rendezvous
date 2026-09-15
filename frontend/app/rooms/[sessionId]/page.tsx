import RoomPage from "../../../components/room-page";

export default async function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <RoomPage sessionId={sessionId} />;
}
