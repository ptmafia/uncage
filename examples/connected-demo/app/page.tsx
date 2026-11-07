import { requireUser } from '../lib/session.ts';
import { Chat } from './chat.tsx';

export default async function Home() {
  await requireUser('/');
  return <Chat />;
}
