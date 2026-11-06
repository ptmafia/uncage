import type { MessageView } from '@uncage/react';
import type { JSX } from 'react';

/** The user's prompt: a right-aligned bubble, plain text (never Markdown). */
export function UserMessage({ message }: { message: MessageView }): JSX.Element {
  return (
    <div className="uc-user">
      <div className="uc-user-bubble">{message.text}</div>
    </div>
  );
}
