# Editor workflow

## Select and edit

Hover a sentence, scenario, section, question or answer to see its outline. Click to select it and focus the agent input. Clicking empty canvas clears the selection; the next instruction applies to the entire feature or ADR.

Double-click titles, text, steps and ADR sections to edit them manually. Valid changes save after a short pause. Enter or clicking outside finishes editing. Escape also finishes and saves; it does not discard the text. Invalid or stale drafts stay open for correction.

The whole-table selection is the **Examples** heading. Individual table cells are directly editable. Question and answer selections are separate; clicking a question targets it for the agent, while hovering it and pressing Enter opens a manual answer.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Z / Cmd+Z | Undo; an unsaved inline draft is reverted before saved history |
| Ctrl+Y / Cmd+Shift+Z | Redo |
| `/` while hovering | Focus the agent instruction |
| Alt+↑ / Alt+↓ | Move through selection hierarchy |
| Enter on a hovered ADR question or answer | Edit its answer manually |
| Tab in a table | Move to the next cell |
| Shift+Enter in a table cell | Insert a row below and focus the same column |
| Shift+Enter on a step | Insert a step below |
| Backspace on a hovered or selected part | Delete that part; protects table headers |

Backspace edits text while a text editor or non-empty agent input is active. With an empty agent input it can delete the visible selection. All structural changes support undo/redo. Input composition does not trigger editor shortcuts.

## Overview and decisions

The studio starts with an overview of all Feature Specs and ADRs. Search both tables by title or filename; click a row or focus its title and press Enter to open the document. The Hoospec wordmark returns to the overview after saving any valid inline draft. Navigation stays local until a document is opened; the overview does not change the team's current document.

ADRs start open. Answering questions and editing the decision section do not silently accept the ADR. Double-click section text, or hover a section and press Enter, to write directly with autosave. Use the quiet status text beside the document kind to explicitly choose open, accepted, rejected or superseded. Agent edits preserve the status.

The document picker also provides quick search and filtering. There is no review completion state or previous/next navigation in the interface. Existing workspace review metadata is retained for file compatibility.

## Collaboration and conflicts

The Node server synchronizes saved changes, shared navigation, presence and live agent drafts. GitLab Pages collects edits in a local session draft. Explicit submission creates a draft merge request; team members can join the same MR and explicitly synchronize further changes. Pages polls that shared branch every 10 seconds and preserves conflicting local drafts. It does not synchronize unsaved input or presence. Local drafts are automatically stored per browser tab and recovered after reload and authorization, with direct conflict resolution; see [GitLab workflow](gitlab.md#entwürfe-und-zusammenarbeit).

If another person changes a document first, the older edit is rejected. Keep your draft, inspect the current saved content and reapply the intended change. Externally changed generated repository files are not silently overwritten.
