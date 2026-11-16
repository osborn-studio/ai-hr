#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一文档文本提取工具：docx / pptx / xlsx / pdf / doc。

用法:
    python3 extract_doc.py <file> [--limit 20000] [--sheet 名称]

输出纯文本到 stdout。--limit 控制最大字符数（默认 20000）。
"""
import sys
import os
import re
import zipfile
import subprocess


def docx_text(path):
    from docx import Document
    d = Document(path)
    out = []
    for para in d.paragraphs:
        t = para.text.strip()
        if t:
            out.append(t)
    for ti, table in enumerate(d.tables, 1):
        out.append(f"[表格 {ti}]")
        for row in table.rows:
            cells = [c.text.strip().replace("\n", " ") for c in row.cells]
            if any(cells):
                out.append(" | ".join(cells))
    return "\n".join(out)


def pptx_text(path):
    out = []
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist()
                 if re.match(r"ppt/slides/slide\d+\.xml$", n)]
        names.sort(key=lambda n: int(re.search(r"slide(\d+)", n).group(1)))
        for n in names:
            num = re.search(r"slide(\d+)", n).group(1)
            xml = z.read(n).decode("utf-8", "ignore")
            texts = re.findall(r"<a:t>(.*?)</a:t>", xml, re.S)
            txt = " ".join(t.strip() for t in texts if t.strip())
            txt = re.sub(r"\s+", " ", txt).strip()
            if txt:
                out.append(f"[slide {num}] {txt}")
        # 备注
        notes = [n for n in z.namelist()
                 if re.match(r"ppt/notesSlides/notesSlide\d+\.xml$", n)]
        notes.sort(key=lambda n: int(re.search(r"notesSlide(\d+)", n).group(1)))
        for n in notes:
            num = re.search(r"notesSlide(\d+)", n).group(1)
            xml = z.read(n).decode("utf-8", "ignore")
            texts = re.findall(r"<a:t>(.*?)</a:t>", xml, re.S)
            txt = " ".join(t.strip() for t in texts if t.strip())
            txt = re.sub(r"\s+", " ", txt).strip()
            if txt:
                out.append(f"[备注 {num}] {txt}")
    return "\n".join(out)


def xlsx_text(path, sheet=None):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    out = []
    for ws in wb.worksheets:
        if sheet and ws.title != sheet:
            continue
        out.append(f"### sheet: {ws.title} (max_row={ws.max_row}, max_col={ws.max_column})")
        for row in ws.iter_rows(values_only=True):
            cells = [str(c).strip() for c in row
                     if c is not None and str(c).strip()]
            if cells:
                out.append(" | ".join(cells))
    return "\n".join(out)


def pdf_text(path):
    from pypdf import PdfReader
    r = PdfReader(path)
    parts = []
    for i, pg in enumerate(r.pages, 1):
        try:
            t = pg.extract_text() or ""
        except Exception:
            t = ""
        if t.strip():
            parts.append(f"[第{i}页]\n{t.strip()}")
    return "\n".join(parts)


def doc_text(path):
    r = subprocess.run(["textutil", "-convert", "txt", "-stdout", path],
                       capture_output=True, text=True)
    return r.stdout


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return 1
    limit = 20000
    sheet = None
    path = None
    i = 0
    while i < len(args):
        if args[i] == "--limit":
            limit = int(args[i + 1]); i += 2
        elif args[i] == "--sheet":
            sheet = args[i + 1]; i += 2
        else:
            path = args[i]; i += 1
    if not path or not os.path.exists(path):
        print(f"ERROR: 文件不存在: {path}", file=sys.stderr)
        return 2
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".docx":
            text = docx_text(path)
        elif ext == ".pptx":
            text = pptx_text(path)
        elif ext in (".xlsx", ".xlsm"):
            text = xlsx_text(path, sheet)
        elif ext == ".pdf":
            text = pdf_text(path)
        elif ext == ".doc":
            text = doc_text(path)
        elif ext in (".txt", ".md", ".csv", ".html"):
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        else:
            print(f"ERROR: 不支持的格式 {ext}", file=sys.stderr)
            return 3
    except Exception as e:
        print(f"ERROR: 解析失败 {path}: {e}", file=sys.stderr)
        return 4
    text = re.sub(r"\n{3,}", "\n\n", text)
    total = len(text)
    if total > limit:
        text = text[:limit] + f"\n\n...[已截断，原文共 {total} 字符]"
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
