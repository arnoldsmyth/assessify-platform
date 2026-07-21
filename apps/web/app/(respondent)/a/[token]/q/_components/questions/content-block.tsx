'use client';

import { ExternalLink } from 'lucide-react';

import { labelFromKey, type Question } from '../../_lib/renderer';

/**
 * Content block (spec 07): non-response section content — never answered and
 * never counted. Per the normative answer-shape table (`content | never
 * answered`) there is no "viewed" record to write: content questions are
 * excluded from required/progress counts on both client
 * (`unansweredRequired`) and server, so simply rendering the block IS
 * completion — nothing blocks navigation past it.
 *
 * `bodyKey` resolves through the same translation-key pipeline as all copy;
 * `mediaUrl` renders inline for known image/video types and falls back to an
 * explicit link otherwise (mixed/unknown media must never dead-end).
 */

interface ContentBlockProps {
  question: Extract<Question, { type: 'content' }>;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v)(\?.*)?$/i;

export function ContentBlock({ question }: ContentBlockProps) {
  const title = labelFromKey(question.textKey);
  const body = labelFromKey(question.bodyKey);

  return (
    <div className="flex flex-col gap-3">
      {title !== '' ? <h3 className="text-lg font-medium text-ink">{title}</h3> : null}
      {body !== '' ? <p className="whitespace-pre-line text-base text-body">{body}</p> : null}
      {question.mediaUrl !== undefined ? <ContentMedia url={question.mediaUrl} title={title} /> : null}
    </div>
  );
}

function ContentMedia({ url, title }: { url: string; title: string }) {
  if (IMAGE_EXTENSIONS.test(url)) {
    return (
      // Plain <img>, not next/image: respondent content media comes from
      // arbitrary product CDNs and next/image would need per-host config
      // in next.config for every tenant.
      <img
        src={url}
        alt={title === '' ? 'Questionnaire content image' : title}
        className="max-w-full rounded-md border border-border"
      />
    );
  }
  if (VIDEO_EXTENSIONS.test(url)) {
    return (
      // Captions must be authored inside the media itself for now; no track
      // source exists in the definition schema (flagged in the C3 report).
      <video src={url} controls preload="metadata" className="w-full rounded-md border border-border" />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      View media
      <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
