/**
 * Shared form-state shape for the invitation actions (D5). Plain module (no
 * directive) so both the server actions and the client controls can import
 * it — a 'use server' file may only export async functions.
 */

export interface InvitationActionState {
  status: 'idle' | 'success' | 'error';
  message?: string;
}

export const initialInvitationActionState: InvitationActionState = { status: 'idle' };
