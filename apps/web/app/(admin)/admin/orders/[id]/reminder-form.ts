/**
 * Shared form-state shape for the reminder actions (D6). Plain module (no
 * directive) so both the server actions and the client controls can import
 * it — a 'use server' file may only export async functions.
 */

export interface ReminderActionState {
  status: 'idle' | 'success' | 'error';
  message?: string;
}

export const initialReminderActionState: ReminderActionState = { status: 'idle' };
