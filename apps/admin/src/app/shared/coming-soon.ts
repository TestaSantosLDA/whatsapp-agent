import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Placeholder for a screen that is not built yet. Inputs come from the route's `data`
 * (component input binding), so a feature folder only needs a routes file to appear.
 */
@Component({
  selector: 'app-coming-soon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <h1 class="page__title">{{ title() }}</h1>
      </header>
      <div class="card empty">
        <p class="empty__text">{{ text() }}</p>
        <p class="muted small">Em preparação ({{ ticket() }}).</p>
      </div>
    </section>
  `,
})
export class ComingSoon {
  readonly title = input('');
  readonly text = input('');
  readonly ticket = input('');
}
