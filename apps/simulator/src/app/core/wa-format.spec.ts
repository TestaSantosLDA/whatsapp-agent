import { formatTime, formatWhatsApp } from './wa-format';
import { WaFormatPipe } from './wa-format.pipe';

describe('formatWhatsApp', () => {
  it('escapes HTML before formatting', () => {
    expect(formatWhatsApp('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('applies bold, italic and strike', () => {
    expect(formatWhatsApp('*Olá* _mundo_ ~velho~')).toBe(
      '<strong>Olá</strong> <em>mundo</em> <s>velho</s>',
    );
  });

  it('does not format markers inside words or with inner spaces at the edges', () => {
    expect(formatWhatsApp('2*3*4 and * not bold *')).toBe('2*3*4 and * not bold *');
    expect(formatWhatsApp('snake_case_name')).toBe('snake_case_name');
  });

  it('renders monospace without formatting its contents', () => {
    expect(formatWhatsApp('```a *b* c```')).toBe('<code class="wa-mono">a *b* c</code>');
  });

  it('auto-links URLs and leaves underscores in them alone', () => {
    expect(formatWhatsApp('Veja https://ex.com/a_b_c.')).toBe(
      'Veja <a href="https://ex.com/a_b_c" target="_blank" rel="noopener noreferrer">https://ex.com/a_b_c</a>.',
    );
    expect(formatWhatsApp('www.ex.pt')).toContain('href="https://www.ex.pt"');
  });

  it('does not let a crafted URL break out of the href attribute', () => {
    const html = formatWhatsApp('https://x.com/"onmouseover="alert(1)');
    expect(html).not.toContain('"onmouseover');
  });

  it('turns newlines into <br>', () => {
    expect(formatWhatsApp('a\nb')).toBe('a<br>b');
  });

  it('is exposed as a pipe', () => {
    expect(new WaFormatPipe().transform('*x*')).toBe('<strong>x</strong>');
    expect(new WaFormatPipe().transform(undefined)).toBe('');
  });
});

describe('formatTime', () => {
  it('formats unix seconds and ISO strings as HH:MM', () => {
    const d = new Date(2026, 9, 21, 9, 5);
    expect(formatTime(String(Math.floor(d.getTime() / 1000)))).toBe('09:05');
    expect(formatTime(d.toISOString())).toBe('09:05');
    expect(formatTime('garbage')).toBe('');
  });
});
