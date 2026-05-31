import { getStaffById } from '@line-crm/db';
import type { MessageSender } from '@line-crm/line-sdk';

type StaffContext = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
};

export type SenderMode = 'official' | 'self';

export type SenderSelection = {
  senderMode?: SenderMode;
  senderStaffId?: string | null;
};

export type ResolvedMessageSender = {
  lineSender?: MessageSender;
  staffId: string | null;
  name: string | null;
  iconUrl: string | null;
};

export class MessageSenderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MessageSenderError';
  }
}

function validateSender(sender: MessageSender): MessageSender {
  const name = sender.name.trim();
  if (!name) {
    throw new MessageSenderError(400, 'sender name is empty');
  }
  if (name.length > 20) {
    throw new MessageSenderError(400, 'sender name must be 20 characters or fewer');
  }
  if (sender.iconUrl && !sender.iconUrl.startsWith('https://')) {
    throw new MessageSenderError(400, 'sender iconUrl must be an HTTPS URL');
  }
  return {
    name,
    ...(sender.iconUrl ? { iconUrl: sender.iconUrl } : {}),
  };
}

export async function resolveMessageSender(
  db: D1Database,
  currentStaff: StaffContext,
  selection: SenderSelection,
): Promise<ResolvedMessageSender> {
  if (selection.senderMode === 'official') {
    return { staffId: null, name: null, iconUrl: null };
  }

  const selectedStaffId =
    selection.senderStaffId ?? currentStaff.id;

  if (!selectedStaffId) {
    return { staffId: null, name: null, iconUrl: null };
  }

  if (selectedStaffId === 'env-owner') {
    if (currentStaff.id !== 'env-owner') {
      throw new MessageSenderError(403, 'only env owner can send as env owner');
    }
    const lineSender = validateSender({ name: currentStaff.name });
    return {
      lineSender,
      staffId: 'env-owner',
      name: lineSender.name,
      iconUrl: lineSender.iconUrl ?? null,
    };
  }

  if (currentStaff.role !== 'owner' && selectedStaffId !== currentStaff.id) {
    throw new MessageSenderError(403, 'only owner can send as another staff member');
  }

  const selectedStaff = await getStaffById(db, selectedStaffId);
  if (!selectedStaff || selectedStaff.is_active !== 1) {
    throw new MessageSenderError(404, 'sender staff not found or inactive');
  }

  const lineSender = validateSender({
    name: selectedStaff.name,
    ...(selectedStaff.icon_url ? { iconUrl: selectedStaff.icon_url } : {}),
  });
  return {
    lineSender,
    staffId: selectedStaff.id,
    name: lineSender.name,
    iconUrl: lineSender.iconUrl ?? null,
  };
}
