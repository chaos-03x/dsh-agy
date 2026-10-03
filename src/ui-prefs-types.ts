export interface UiPrefsView {
  conversationBadge: boolean
}

export interface SetUiPrefsPayload {
  conversationBadge: boolean
}

export interface UiPrefsDocument {
  version: 1
  conversationBadge?: boolean
}
