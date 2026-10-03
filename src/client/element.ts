/**
 * The element shorthand the browser half is written in.
 *
 * `h(tag, props, ...children)` keeps an element tree flat and readable where
 * nested `createElement` calls become a parenthesis maze — and this bundle has
 * no JSX transform, so there is no third option.
 *
 * A shared module rather than a copy per file: the Settings section and the
 * conversation-header badge build their trees the same way.
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'

/**
 * Element shorthand: flat children, no nesting ceremony.
 *
 * The component overload accepts children as trailing arguments too, because
 * React's `createElement` handles them natively for function components.
 */
export function h(tag: string, props?: Record<string, unknown> | null, ...children: ReactNode[]): ReactNode
export function h<Props>(
  // `key` rides in props for `createElement`, so the component overload must
  // admit it even though it is not part of the component's own props type.
  component: (props: Props) => ReactNode,
  props: Props & { key?: string | number },
  ...children: ReactNode[]
): ReactNode
export function h(
  tag: string | ((props: never) => ReactNode),
  props?: Record<string, unknown> | null,
  ...children: ReactNode[]
): ReactNode {
  return createElement(tag as string, props ?? null, ...children)
}
