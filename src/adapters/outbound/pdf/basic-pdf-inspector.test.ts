import { describe, expect, it } from 'vitest';

import { BasicPdfInspector, MAX_ATTACHMENT_BYTES } from './basic-pdf-inspector';

const pdf = (body = '1 0 obj << /Type /Catalog >> endobj', version = '1.7') =>
  new Uint8Array(Buffer.from(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n${body}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1'));

describe('BasicPdfInspector', () => {
  const inspector = new BasicPdfInspector();

  it('accepts a plain single-revision PDF (1.x and 2.0), with trailing whitespace', async () => {
    expect(await inspector.inspect(pdf())).toEqual({ ok: true });
    expect(await inspector.inspect(pdf(undefined, '2.0'))).toEqual({ ok: true });
  });

  it.each([
    ['nothing in front of the signature', ` ${Buffer.from(pdf()).toString('latin1')}`],
    ['another format', 'PK\x03\x04 zip'],
    ['unknown version', '%PDF-3.1\n%%EOF'],
    ['data after %%EOF', `${Buffer.from(pdf()).toString('latin1')}<html>`],
    ['empty file', ''],
  ])('rejects as NOT_A_PDF: %s', async (_case, text) => {
    expect(await inspector.inspect(new Uint8Array(Buffer.from(text, 'latin1')))).toMatchObject({ ok: false, error: 'NOT_A_PDF' });
  });

  it('rejects encrypted PDFs', async () => {
    expect(await inspector.inspect(pdf('trailer << /Encrypt 5 0 R >>'))).toMatchObject({ ok: false, error: 'PDF_ENCRYPTED' });
  });

  it.each(['/JavaScript', '/JS (app.alert)', '/OpenAction 3 0 R', '/AA <<>>', '/Launch', '/EmbeddedFile', '/RichMedia', '/XFA', '/SubmitForm'])(
    'rejects active content %s',
    async (name) => {
      expect(await inspector.inspect(pdf(`<< ${name} >>`))).toMatchObject({ ok: false, error: 'PDF_ACTIVE_CONTENT' });
    },
  );

  it('does not confuse longer names with active content', async () => {
    expect(await inspector.inspect(pdf('<< /JSONData 1 /AAPL 2 /Launcher 3 >>'))).toEqual({ ok: true });
  });

  it('rejects incremental updates above the threshold', async () => {
    const updated = new Uint8Array(Buffer.concat([pdf(), Buffer.from('2 0 obj << >> endobj\n%%EOF\n')]));
    expect(await inspector.inspect(updated)).toMatchObject({ ok: false, error: 'PDF_INCREMENTAL_UPDATE' });
    expect(await new BasicPdfInspector({ maxIncrementalUpdates: 1 }).inspect(updated)).toEqual({ ok: true });
  });

  it('rejects files above 15 MB', async () => {
    expect(await inspector.inspect(new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toEqual({ ok: false, error: 'ATTACHMENT_TOO_LARGE' });
  });
});
