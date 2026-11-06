import { randomUUID } from 'node:crypto';

export type IdPrefix = 'ses' | 'run' | 'apr' | 'msg' | 'tool' | 'req';

export const newId = (prefix: IdPrefix): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export const formatEventId = (sequence: number): string =>
  `evt_${String(sequence).padStart(10, '0')}`;

export const parseEventId = (eventId: string): number | null => {
  const match = /^evt_(\d{10})$/.exec(eventId);
  return match?.[1] === undefined ? null : Number(match[1]);
};
