import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { DevLoginMember } from '@wa/shared';
import { AuthService } from '../core/auth.service';
import { SessionStore } from '../core/session.store';

const errors: Record<string, string> = {
  'sem-equipa': 'A sua conta não pertence a nenhuma equipa. Peça a um administrador que o convide.',
  falha: 'Não foi possível carregar o painel. Tente de novo.',
};

/** Sign-in (WA-022): email link or code, Google, and the dev login in local development. */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="login">
      <div class="login__card">
        <div class="login__brand">
          <span class="brand-mark brand-mark--lg" aria-hidden="true">W</span>
          <div>
            <h1 class="login__title">Painel da equipa</h1>
            <p class="muted small">Conversas, pedidos e clientes do assistente de WhatsApp.</p>
          </div>
        </div>

        @if (erro() && errors[erro()!]) {
          <p class="notice notice--error" role="alert">{{ errors[erro()!] }}</p>
          @if (auth.status() === 'signed-in') {
            <button type="button" class="btn" (click)="signOut()">Entrar com outra conta</button>
          }
        }

        @if (auth.status() === 'loading') {
          <p class="muted">A carregar…</p>
        } @else if (auth.supabaseEnabled()) {
          @if (!sentTo()) {
            <form class="stack-sm" (submit)="$event.preventDefault(); sendLink(email.value)">
              <label class="field__label" for="email">Email de trabalho</label>
              <input
                #email
                id="email"
                class="input input--lg"
                type="email"
                autocomplete="email"
                inputmode="email"
                placeholder="nome@empresa.pt"
                required
              />
              <button type="submit" class="btn btn--primary btn--lg" [disabled]="busy()">
                Enviar link de acesso
              </button>
            </form>
          } @else {
            <form class="stack-sm" (submit)="$event.preventDefault(); verify(code.value)">
              <p class="notice">
                Enviámos um link para <strong>{{ sentTo() }}</strong
                >. Abra-o neste aparelho, ou escreva aqui o código do mesmo email.
              </p>
              <label class="field__label" for="code">Código</label>
              <input
                #code
                id="code"
                class="input input--lg input--code"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="10"
                placeholder="123456"
              />
              <button type="submit" class="btn btn--primary btn--lg" [disabled]="busy()">
                Entrar
              </button>
              <button type="button" class="btn btn--ghost" (click)="sentTo.set(null)">
                Usar outro email
              </button>
            </form>
          }
          <div class="divider"><span>ou</span></div>
          <button
            type="button"
            class="btn btn--lg btn--google"
            [disabled]="busy()"
            (click)="google()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" class="google-icon">
              <path
                fill="#4285F4"
                d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"
              />
              <path
                fill="#34A853"
                d="M12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"
              />
              <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z" />
              <path
                fill="#EA4335"
                d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z"
              />
            </svg>
            Entrar com Google
          </button>
          <p class="muted small center">Só para pessoas convidadas pela empresa.</p>
        } @else if (!auth.devLoginEnabled()) {
          <p class="notice">
            O início de sessão ainda não está configurado neste servidor (SUPABASE_URL e
            SUPABASE_ANON_KEY).
          </p>
        }

        @if (message()) {
          <p class="field__error" role="alert">{{ message() }}</p>
        }

        @if (auth.devLoginEnabled()) {
          <section class="dev">
            <h2 class="dev__title">Desenvolvimento local</h2>
            <p class="muted small">
              ADMIN_DEV_LOGIN: entre como um membro da equipa de demonstração.
            </p>
            <ul class="dev__list">
              @for (m of devMembers(); track m.id) {
                <li>
                  <button type="button" class="dev__member" (click)="devLogin(m)">
                    <span class="dev__name">{{ m.name || m.email }}</span>
                    <span class="muted small">
                      {{ m.clientId }} · {{ m.role === 'admin' ? 'administrador' : 'comercial' }}
                      @if (m.branches.length) {
                        · {{ m.branches.join(', ') }}
                      }
                    </span>
                  </button>
                </li>
              } @empty {
                <li class="muted small">Sem membros. Corra <code>pnpm db:seed</code>.</li>
              }
            </ul>
          </section>
        }
      </div>
    </main>
  `,
})
export class LoginPage {
  protected readonly auth = inject(AuthService);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  /** `?erro=` from the guard. */
  readonly erro = input<string>();
  protected readonly errors = errors;
  protected readonly busy = signal(false);
  protected readonly sentTo = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly devMembers = signal<DevLoginMember[]>([]);

  constructor() {
    void this.start();
  }

  private async start(): Promise<void> {
    await this.auth.ready();
    if (this.auth.status() === 'signed-in' && !this.erro()) {
      await this.router.navigateByUrl('/');
      return;
    }
    if (this.auth.devLoginEnabled()) {
      this.devMembers.set(await this.auth.devMembers().catch(() => []));
    }
  }

  protected async sendLink(email: string): Promise<void> {
    if (!email.includes('@')) return;
    await this.run(async () => {
      await this.auth.sendMagicLink(email);
      this.sentTo.set(email.trim().toLowerCase());
    });
  }

  protected async verify(code: string): Promise<void> {
    const email = this.sentTo();
    if (!email || !code.trim()) return;
    await this.run(async () => {
      await this.auth.verifyCode(email, code);
      await this.router.navigateByUrl('/');
    });
  }

  protected google(): Promise<void> {
    return this.run(() => this.auth.signInWithGoogle());
  }

  protected async devLogin(member: DevLoginMember): Promise<void> {
    await this.run(async () => {
      await this.auth.devLogin(member);
      this.session.reset();
      await this.router.navigateByUrl('/');
    });
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    this.session.reset();
    await this.router.navigate(['/login']);
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      await action();
    } catch (e) {
      this.message.set(friendly(e));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Supabase's messages are in English; the usual ones in pt-PT. */
function friendly(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/signups? not allowed|user not found/i.test(text)) {
    return 'Este email não foi convidado. Peça um convite a um administrador.';
  }
  if (/expired|invalid/i.test(text)) return 'Código inválido ou expirado. Peça um novo link.';
  if (/rate limit|too many/i.test(text)) return 'Muitos pedidos seguidos. Espere um minuto.';
  return text;
}
