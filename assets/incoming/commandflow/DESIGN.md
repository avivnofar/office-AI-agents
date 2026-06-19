---
name: Terminal Interface System
colors:
  surface: '#131315'
  surface-dim: '#131315'
  surface-bright: '#39393b'
  surface-container-lowest: '#0e0e10'
  surface-container-low: '#1b1b1d'
  surface-container: '#1f1f21'
  surface-container-high: '#2a2a2b'
  surface-container-highest: '#353436'
  on-surface: '#e4e2e4'
  on-surface-variant: '#c6c6cd'
  inverse-surface: '#e4e2e4'
  inverse-on-surface: '#303032'
  outline: '#909097'
  outline-variant: '#45464d'
  surface-tint: '#bec6e0'
  primary: '#bec6e0'
  on-primary: '#283044'
  primary-container: '#0f172a'
  on-primary-container: '#798098'
  inverse-primary: '#565e74'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#dec29a'
  on-tertiary: '#3e2d11'
  tertiary-container: '#231500'
  on-tertiary-container: '#957d5a'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#fcdeb5'
  tertiary-fixed-dim: '#dec29a'
  on-tertiary-fixed: '#271901'
  on-tertiary-fixed-variant: '#574425'
  background: '#131315'
  on-background: '#e4e2e4'
  surface-variant: '#353436'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '700'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  code-block:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.7'
  code-inline:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1.0'
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1.0'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 20px
  margin: 24px
---

## Brand & Style
This design system is engineered for IT specialists and developers, prioritizing high-density information architecture with a "Modern Terminal" aesthetic. The brand personality is technical, authoritative, and precise. 

The design style utilizes **Glassmorphism** and **Modern Corporate** influences to bridge the gap between a raw CLI and a premium educational platform. The interface relies on translucent overlays, subtle backdrop blurs (12px–20px), and razor-sharp borders to create a layered environment that mimics high-end IDEs. The emotional response should be one of "controlled complexity"—giving the user a sense of professional mastery and technological sophistication.

## Colors
The palette is rooted in a deep, nocturnal spectrum to minimize eye strain during long simulation sessions. 

- **Primary (#0F172A):** Used for deep structural elements like sidebars and the main terminal background.
- **Secondary (#10B981):** Reserved for success states, active command prompts, and positive output.
- **Accent (#3B82F6):** Used for interactive elements, progress indicators, and syntax highlighting.
- **Background (#1E293B):** The canvas for content cards and educational modules.
- **Text:** Primary White (#F8FAFC) ensures maximum legibility against dark backgrounds, while Dimmed Gray (#94A3B8) is used for metadata, comments, and inactive states.

## Typography
The system employs a dual-font strategy. **Inter** provides a neutral, highly legible foundation for educational prose and UI controls. **JetBrains Mono** is utilized for all terminal inputs, outputs, and code-related snippets, offering the specific technical character required for IT training.

Hierarchies are reinforced through weight and color (using Dimmed Gray for secondary info) rather than extreme size shifts. All code blocks should maintain a consistent line height of 1.7 to ensure readability during complex multi-line command simulations.

## Layout & Spacing
The layout follows a **Fixed Grid** model on desktop (12 columns, max-width 1440px) and transitions to a fluid single-column stack on mobile. 

The spacing rhythm is based on a 4px baseline. Components like the terminal emulator should utilize "tight" internal spacing (8px–12px) to mimic actual dev tools, while educational content (lesson text, diagrams) uses "loose" spacing (24px–40px) to prevent cognitive overload. Sidebars are docked with a fixed width of 280px on desktop to provide a persistent navigation anchor.

## Elevation & Depth
Depth is created through **Tonal Layering** combined with **Glassmorphism**. 

1.  **Floor (Level 0):** Background (#1E293B).
2.  **Surface (Level 1):** Cards and main terminal window using Primary (#0F172A) with a 1px border (#334155).
3.  **Float (Level 2):** Modals and dropdowns utilizing a translucent primary color with a `backdrop-filter: blur(16px)` and a subtle outer glow using the Accent color at 10% opacity.

Avoid heavy drop shadows; instead, use inner borders (stroke-inner) and subtle value shifts to indicate stack order.

## Shapes
This design system uses a **Soft (0.25rem)** roundedness approach. This maintains the "technical" feel of a terminal while subtly acknowledging modern web trends. 

- **Small elements (Buttons, Chips):** 4px (rounded-sm)
- **Medium elements (Cards, Terminal Window):** 8px (rounded-lg)
- **Large elements (Outer Containers):** 12px (rounded-xl)

Interactive states should never use pill-shapes; maintain the structured, rectangular integrity of a professional IDE.

## Components
- **Buttons:** Primary buttons are solid Command Blue (#3B82F6). Secondary buttons use an outline style with a 1px border and no fill. All buttons feature a 0.2s transition on hover with a subtle brightness increase.
- **Terminal Emulator:** Must use JetBrains Mono. The header should include "traffic light" window controls (red/yellow/green) to enhance the OS-metaphor.
- **Chips:** Used for "Command Syntax" tags. These should have a background of #334155 and no border, with text in Accent color.
- **Input Fields:** Darker than the background (#0F172A) with a 1px border that glows Command Blue on focus.
- **Progress Steppers:** Use a vertical "Terminal Tree" aesthetic, connecting lesson nodes with thin gray lines that turn Terminal Green as tasks are completed.
- **Code Blocks:** Syntax highlighting should be vibrant against the dark background, utilizing Terminal Green for strings and Command Blue for keywords.