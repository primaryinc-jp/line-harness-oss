import { describe, expect, it } from 'vitest';
import { MessageSenderError, resolveMessageSender } from './message-sender.js';

function dbWithStaff(row: Record<string, unknown> | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as D1Database;
}

describe('resolveMessageSender', () => {
  it('returns undefined for official-account sends', async () => {
    await expect(
      resolveMessageSender(
        dbWithStaff(null),
        { id: 'staff-1', name: 'Alice', role: 'staff' },
        { senderMode: 'official' },
      ),
    ).resolves.toEqual({ staffId: null, name: null, iconUrl: null });
  });

  it('resolves self from the staff table', async () => {
    await expect(
      resolveMessageSender(
        dbWithStaff({ id: 'staff-1', name: 'Alice', icon_url: 'https://example.com/a.png', is_active: 1 }),
        { id: 'staff-1', name: 'Alice', role: 'staff' },
        { senderMode: 'self' },
      ),
    ).resolves.toEqual({
      lineSender: { name: 'Alice', iconUrl: 'https://example.com/a.png' },
      staffId: 'staff-1',
      name: 'Alice',
      iconUrl: 'https://example.com/a.png',
    });
  });

  it('allows owners to select another active staff member', async () => {
    await expect(
      resolveMessageSender(
        dbWithStaff({ id: 'staff-2', name: 'Bob', icon_url: null, is_active: 1 }),
        { id: 'owner-1', name: 'Owner', role: 'owner' },
        { senderStaffId: 'staff-2' },
      ),
    ).resolves.toEqual({
      lineSender: { name: 'Bob' },
      staffId: 'staff-2',
      name: 'Bob',
      iconUrl: null,
    });
  });

  it('rejects non-owners selecting another staff member', async () => {
    await expect(
      resolveMessageSender(
        dbWithStaff({ id: 'staff-2', name: 'Bob', icon_url: null, is_active: 1 }),
        { id: 'staff-1', name: 'Alice', role: 'staff' },
        { senderStaffId: 'staff-2' },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects invalid sender icon URLs before calling LINE', async () => {
    await expect(
      resolveMessageSender(
        dbWithStaff({ id: 'staff-1', name: 'Alice', icon_url: 'http://example.com/a.png', is_active: 1 }),
        { id: 'staff-1', name: 'Alice', role: 'staff' },
        { senderMode: 'self' },
      ),
    ).rejects.toBeInstanceOf(MessageSenderError);
  });
});
