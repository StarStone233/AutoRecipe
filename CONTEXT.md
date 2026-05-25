# AutoRecipe Context

AutoRecipe learns a user's workflow inside a bounded website context and presents the resulting knowledge as pages, actions, requests, rules, and recipes.

## Language

**Learning Scope**:
The website boundary AutoRecipe is allowed to learn from during a capture. A Learning Scope is the registrable domain of the starting URL, so `app.example.com` and `api.example.com` belong to the same scope, while unrelated domains do not.
_Avoid_: Domain, site, system, target host

**External Activity**:
Captured browser activity outside the Learning Scope. External Activity is kept as underlying evidence and may be associated with in-scope activity, but it is not displayed as learned knowledge.
_Avoid_: Learned page, learned request, out-of-domain knowledge

**Page Surface**:
A visible operation surface inside the Learning Scope that can contain user actions. A Page Surface may be a full page, a popup, a dialog, a drawer, a dropdown, an iframe, or a child window.
_Avoid_: Page when URL is meant, overlay, layer

**Primary Page**:
The Page Surface represented by the main browser navigation URL. One Primary Page may contain many Secondary Surfaces.
_Avoid_: Current URL page, main document

**Secondary Surface**:
A Page Surface attached to a Primary Page, such as a menu, search options popup, filter drawer, dialog, or dropdown. A Secondary Surface has its own visual bounds and action coordinates even when the URL does not change.
_Avoid_: Heat zone, modal event, popup as page

**Child Window Surface**:
A Page Surface opened in a separate window or popup while still inside the Learning Scope. It belongs to the action or Primary Page that opened it, but keeps its own surface identity and coordinates.
_Avoid_: External page, standalone learned page

**Viewport Bounds**:
The position and size of an action or Page Surface relative to the browser viewport. Viewport Bounds are raw evidence and are not the preferred coordinate system for learned overlays.
_Avoid_: Absolute coordinates, screen coordinates

**Surface Bounds**:
The position and size of an action relative to its owning Page Surface. Surface Bounds are the preferred coordinate system for learned overlays.
_Avoid_: Heat zone coordinates, display coordinates

**Surface Detection**:
The act of assigning a captured action to its owning Page Surface. Detection prefers active dialogs, popovers, menus, drawers, dropdowns, child windows, and iframes before falling back to the Primary Page.
_Avoid_: Region inference, CSS classification

**Learned Request**:
A network request inside the Learning Scope and associated with a learned action or Page Surface. Requests outside the Learning Scope remain evidence only and do not appear in the request catalog or learned display.
_Avoid_: Captured request, API call

**Surface-first Display**:
The default learned-knowledge view organized by Primary Page and Page Surface. Surface-first Display prioritizes screenshots, surface bounds, overlays, action counts, and in-scope request counts before lower-level request, rule, or recipe lists.
_Avoid_: Artifact list, JSON summary, run summary

## Example Dialogue

Developer: "The capture started on `https://cn.bing.com`, so the Learning Scope is `bing.com`."

Domain expert: "Correct. Pages and API calls under `bing.com` can become learned knowledge; unrelated domains should not appear as learned content."

Developer: "A login redirect touched `login.example-idp.com`; should it appear in Learned?"

Domain expert: "No. It is External Activity: keep it as evidence, but do not show it as learned knowledge."

Developer: "Bing opens search options in a popup without changing the URL. Is that a new page?"

Domain expert: "It is a Secondary Surface under the current Primary Page. It needs its own bounds and coordinates, but it is not a separate Primary Page."

Developer: "Should the overlay use the button's viewport position?"

Domain expert: "Only as raw evidence. The learned overlay should use Surface Bounds so actions inside a popup are drawn on that popup, not on the full page."

Developer: "A popup belongs to the current Bing page and has no URL. Is it in scope?"

Domain expert: "Yes. A Secondary Surface inherits the Learning Scope of its Primary Page."

Developer: "What should I see first after a capture?"

Domain expert: "Show the learned Page Surfaces first, with screenshots and overlays, so the capture effect is visible immediately."
