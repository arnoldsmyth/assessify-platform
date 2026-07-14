/** Mailer adapter contract (appendix-architecture-layers.md §4). */
export interface Mailer {
  send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<void>;
}
