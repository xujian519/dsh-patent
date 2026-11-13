#!/usr/bin/env python3
"""Record the 2026 revision's change points against the 2023 guideline index.

《专利审查指南》2026 年版（局令第84号，2026-01-01 施行）没有随包的合订全文，知识库
只有官方修改对照表。索引要以 2023 年文本为底、并如实说明哪些节已被 2026 年版修改，
就需要把对照表里每一处改动登记成机器可读的数据：哪一节（2023 编号）、改成了哪一节
（2026 编号）、改动前后的文本。

对照表的排版决定了解析规则：

- 一页分左右两栏，左栏是修改前文本、右栏是修改后文本，同一个改动点在两栏的纵向位置
  相同；两栏各自的页眉页脚与页码要去掉。
- 节标题用黑体（SimHei），正文用宋体（SimSun）；编号用 Times New Roman，因此「标题行」
  的判据是「没有任何宋体 span，且有黑体 span」。
- 编号后移的节在右栏同一行印出「旧编号 新编号」两个数字 span，例如 `6.1.1` `6.1.2`；
  按行取全部数字 span 即可得到这条重编号。
- 新增节只在右栏出现，删除节只在左栏出现。
- 有些改动的节标题没有重复印出，只在左栏以正文的样子写出节路径（如 `1.3.2.6 专利权期限
  的补偿`）；这类行按「栏首编号 + 标题」识别，登记为 `amended`。

归一化的节路径与 `src/reference.ts` 一致：第X部分第Y章 + 编号，例如 `第二部分第九章6.1.2`。

用法：
  python3 tools/guideline-changes.py --check [--pdf PATH] [--yaml PATH]
  python3 tools/guideline-changes.py --write [--pdf PATH]

`--write` 重写每条记录的 `oldColumnText` / `newColumnText` / `renames` / `added`，并保留人工核定的
`kind` 与 `note`；`--check` 只比对，不写文件。源 PDF 不在仓库中，缺失时脚本报「未核验」
而不是静默通过，所以随包资产本身是唯一存证。

右栏不是可以直接引用的现行条文：对照表用增删标记排版，文字图层把删除的词与插入的词都
输出成正文，肉眼可辨、机器不可辨。因此本资产只登记「改动落在哪一节、改动前后的栏文本」，
把标记还原成条文仍要人工完成；索引 `versions` 里已转录的三节就是按标记人工还原的结果。
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import NoReturn

PDF_DEFAULT = Path(
    '/Users/xujian/projects/宝宸知识库_Raw/专利审查指南/审查指南修改/《专利审查指南》修改对照表.pdf'
)
YAML_DEFAULT = Path(__file__).resolve().parent.parent / 'assets/authority/guideline-changes-2026.yaml'

PART_PATTERN = re.compile(r'^第([一二三四五六])部分(?:第([一二三四五六七八九十]+)章)?$')
SECTION_PATTERN = re.compile(r'^(\d+(?:\.\d+)*)\.?\s*(.*)$')
NUMBER_ONLY = re.compile(r'^\d+(?:\.\d+)*\.?$')
PAGE_NUMBER = re.compile(r'^[—\-–\s]*\d+[—\-–\s]*$')
BODY_FONTS = ('SimSun', 'Song', '宋', 'Kai', 'FangSong')
HEAD_FONTS = ('SimHei', 'Black', 'Hei')
FOOTER_TOP = 515.0
GUTTER = 420.0

# 对照表把「旧编号 新编号」印在同一行；这两个节的右栏行号与左栏错位，无法按纵坐标配对，
# 因此按人工阅读的结果登记，`note` 说明读数依据。
RENAMES_BY_HAND = {
    '第二部分第九章6.1.1': ('第二部分第九章6.1.2', '右栏同一行印出 6.1.1 与 6.1.2，标题「根据专利法第二十五条第一款第（二）项的审查」'),
    '第二部分第九章6.1.2': ('第二部分第九章6.1.3', '右栏同一行印出 6.1.2 与 6.1.3，标题「根据专利法第二条第二款的审查」'),
    '第二部分第九章6.1.3': ('第二部分第九章6.1.4', '右栏同一行印出 6.1.3 与 6.1.4，标题「新颖性和创造性的审查」'),
    '第五部分第七章8.3': ('第五部分第七章8.4', '左栏 8.3「延迟审查」在右栏印为 8.4，正文未改'),
    '第五部分第七章8.4': ('第五部分第七章8.5', '左栏 8.4「专利局自行启动」在右栏印为 8.5，正文未改'),
}

# 新增节只在右栏出现；这些节名在左栏没有对应编号，登记为 `added`。
#
# 列表是显式的：对照表把「旧编号 新编号」印在同一行时，共用的前缀只印一次（`8.` `3` `4`），
# 逐 span 取数字会造出 `8.34` 这种伪编号。新增节按右栏黑体标题人工核对后登记。
ADDED_BY_HAND = {
    '第二部分第九章6.1.1': '右栏新增「根据专利法第五条第一款的审查」，原 6.1.1 起编号后移',
    '第二部分第九章6.3.3': '右栏新增审查示例',
    '第二部分第九章7': '右栏新增「包含比特流的发明专利申请审查相关规定」一章',
    '第二部分第九章7.1': '右栏新增本章第 7.1 节',
    '第二部分第九章7.1.1': '右栏新增第 7.1.1 节',
    '第二部分第九章7.1.2': '右栏新增第 7.1.2 节',
    '第二部分第九章7.2': '右栏新增本章第 7.2 节',
    '第二部分第九章7.2.1': '右栏新增第 7.2.1 节',
    '第二部分第九章7.2.2': '右栏新增第 7.2.2 节',
    '第四部分第三章4.6.4': '右栏新增「修改文本的提交」',
    '第五部分第七章8.3': '右栏新增「快速审查」，原 8.3 起编号后移',
}


def fail(message: str) -> NoReturn:
    """Exit with a concise, user-correctable error."""
    print(f'guideline-changes: {message}', file=sys.stderr)
    raise SystemExit(1)


def split_sides(line: dict) -> list[list[dict]]:
    """Group one PDF line's spans by the column they sit in, keeping order."""
    groups: list[list[dict]] = []
    sides: list[bool] = []
    for span in line['spans']:
        if not span['text'].strip():
            continue
        left = span['bbox'][0] < GUTTER
        if sides and sides[-1] == left:
            groups[-1].append(span)
        else:
            sides.append(left)
            groups.append([span])
    return [group for group in groups if group]


def heading_span(group: list[dict]) -> bool:
    """True when a span group is set in the heading font with no body-font span."""
    if any(any(name in span['font'] for name in BODY_FONTS) for span in group):
        return False
    return any(any(name in span['font'] for name in HEAD_FONTS) for span in group)


def line_text(group: list[dict]) -> str:
    """The visible text of one span group."""
    return ''.join(span['text'] for span in group).strip()


def read_column(document, page: int, left: bool) -> list[tuple[float, str, bool, list[str]]]:
    """Rows of one column: y, text, whether it is a heading, and the row's number spans."""
    rows = []
    for block in document[page].get_text('dict')['blocks']:
        if block['type'] != 0:
            continue
        for line in block['lines']:
            if line['bbox'][1] > FOOTER_TOP:
                continue
            for group in split_sides(line):
                if (group[0]['bbox'][0] < GUTTER) != left:
                    continue
                text = line_text(group)
                if not text or PAGE_NUMBER.match(text):
                    continue
                numbers = [span['text'].strip() for span in group if NUMBER_ONLY.match(span['text'].strip())]
                rows.append((line['bbox'][1], text, heading_span(group), numbers))
    return sorted(rows)


@dataclass
class Segment:
    """One section's text under one part and chapter, plus the numbers printed beside it."""
    part: str
    number: str
    title: str
    lines: list[str] = field(default_factory=list)
    numbers: list[str] = field(default_factory=list)


class Stream:
    """Ordered segments of one column, keeping the part and chapter across pages."""

    def __init__(self) -> None:
        self.segments: list[Segment] = []
        self.current: Segment | None = None
        self.part: str | None = None

    def feed(self, rows: list[tuple[float, str, bool, list[str]]]) -> None:
        """Append one page's rows to the stream."""
        for _, text, heading, numbers in rows:
            if heading:
                match = PART_PATTERN.match(text)
                if match:
                    self.part = f'第{match.group(1)}部分' + (
                        f'第{match.group(2)}章' if match.group(2) else ''
                    )
                    self.current = Segment(self.part, '', '', numbers=numbers)
                    self.segments.append(self.current)
                    continue
                match = SECTION_PATTERN.match(text)
                if match:
                    self.current = Segment(self.part or '', match.group(1), match.group(2).strip(),
                                           numbers=numbers)
                    self.segments.append(self.current)
                    continue
                if self.current is not None and self.current.number and not self.current.lines:
                    self.current.title = (self.current.title + text).strip()
                    continue
            match = SECTION_PATTERN.match(text)
            if match and match.group(2) and len(match.group(1).split('.')) > 1:
                # 栏首以正文样式写出的节路径（标题未被重复印出）。
                self.current = Segment(self.part or '', match.group(1), match.group(2).strip())
                self.segments.append(self.current)
                continue
            if self.current is not None:
                self.current.lines.append(text)


def merge(segments: list[Segment]) -> dict[tuple[str, str], Segment]:
    """Merge segments by part and number, keeping the longest title and all text."""
    merged: dict[tuple[str, str], Segment] = {}
    for segment in segments:
        if not segment.number:
            continue
        key = (segment.part, segment.number)
        if key in merged:
            merged[key].lines += segment.lines
            merged[key].numbers += segment.numbers
            if len(segment.title) > len(merged[key].title):
                merged[key].title = segment.title
        else:
            merged[key] = Segment(segment.part, segment.number, segment.title,
                                  list(segment.lines), list(segment.numbers))
    return merged


def content(lines: list[str]) -> list[str]:
    """The text lines of one segment without the table's omission markers."""
    return [line for line in lines if line.strip() not in ('……', '......')]


def read_changes(pdf: Path) -> dict:
    """Parse the change table into change points, renumbers and additions."""
    try:
        import fitz
    except ImportError:
        fail('缺少 PyMuPDF：请运行 python3 -m pip install pymupdf')
    document = fitz.open(str(pdf))
    old, new = Stream(), Stream()
    for page in range(document.page_count):
        old.feed(read_column(document, page, True))
        new.feed(read_column(document, page, False))
    old_map, new_map = merge(old.segments), merge(new.segments)

    renames: list[dict] = []
    for key, (target, note) in RENAMES_BY_HAND.items():
        part, number = split_path_key(key)
        if (part, number) not in old_map:
            fail(f'重编号的旧节不在对照表中：{key}')
        renames.append({'from': key, 'to': target, 'note': note})

    added: list[dict] = []
    added_paths: dict[str, dict] = {}
    for key in ADDED_BY_HAND:
        part, number = split_path_key(key)
        if (part, number) not in new_map:
            fail(f'新增节不在对照表右栏中：{key}')
        segment = new_map[(part, number)]
        added_paths[key] = {
            'path': key,
            'title': segment.title,
            'note': ADDED_BY_HAND[key],
            'newColumnText': content(segment.lines),
        }
        added.append(added_paths[key])

    points: list[dict] = []
    rename_from = {rename['from']: rename for rename in renames}
    for key in sorted(old_map, key=lambda item: (item[0], item[1])):
        part, number = key
        old_segment, new_segment = old_map[key], new_map.get(key)
        path = f'{part}{number}'
        title = (new_segment or old_segment).title
        old_text = content(old_segment.lines)
        # 改编号的节只登记编号变化；正文未改时它的文本就是原文。右栏同编号的文本属于
        # 2026 版新增的那一节，不能当成这一节的“改后文本”。
        new_text = old_text if path in rename_from else content(new_segment.lines if new_segment else [])
        if path in rename_from and old_text == new_text and not old_text:
            continue
        if not old_text and not new_text:
            continue
        if old_text and not new_text:
            kind, note = 'deleted', ''
        elif path in rename_from:
            kind, note = 'renumbered', rename_from[path]['note']
        elif new_text and not old_text:
            kind, note = 'added', ''
        else:
            kind, note = 'amended', ''
        points.append({
            'path': path, 'title': title, 'kind': kind, 'note': note,
            'oldColumnText': old_text, 'newColumnText': new_text,
        })

    return {
        'sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
        'revision': '2026 年修订版（2026-01-01 施行）',
        'sourceDoc': '《专利审查指南》修改对照表（国家知识产权局令第84号）',
        'renames': renames,
        'added': added,
        'changePoints': points,
    }


def split_path_key(key: str) -> tuple[str, str]:
    """Split `第二部分第九章6.1.2` into its part and chapter, and its section number."""
    match = re.match(r'^(第[一二三四五六]部分第[一二三四五六七八九十]+章)(.+)$', key)
    if not match:
        fail(f'节路径无法解析：{key}')
    return match.group(1), match.group(2)


def render(data: dict, curated: dict[str, dict]) -> str:
    """Render the change-point asset, keeping the curated kind and note per path."""
    out = [
        '# 《专利审查指南》2026 年修订版改动点 — 评审基准，不是运行时索引。',
        '#',
        '# 本文件按官方修改对照表逐节登记 2026 年修订版对 2023 年修订版做了哪些改动：',
        '# 哪一节的文本变了、哪几节改了编号、哪几节是新增。索引据此把受影响的 2023 节标为',
        '# stale（staleSections 只能指向已索引的节，因此这项标记跟在全量转录之后），评审据此',
        '# 核对 2026 年文本的覆盖面。',
        '#',
        '# 由 tools/guideline-changes.py 从对照表机械抽取，人工核定只涉及 kind 与 note：',
        '# 对照表把节标题印成黑体、正文印成宋体，编号用 Times New Roman 印在标题行首；',
        '# 编号后移的节在右栏同一行印出两个数字。正文按 PDF 固定列折行保留，换行不是段落边界。',
        '#',
        '# oldColumnText / newColumnText 是左右两栏的文字层内容。右栏用增删标记排版，文字层把',
        '# 删除的词与插入的词都输出成正文，因此 newColumnText 不是可直接引用的现行条文，只用来说明',
        '# 改动落在哪一节；把标记还原成条文要人工完成（索引 versions 的三节即人工还原结果）。',
        '#',
        '# 源文件不在仓库中，缺失时脚本报「未核验」；随包资产是唯一存证。',
        f'#',
        f'# 源文件 SHA-256：{data["sha256"]}',
        f'version: "1.0"',
        f'revision: {data["revision"]}',
        f'sourceDoc: {data["sourceDoc"]}',
        f'sourceSha256: {data["sha256"]}',
        'verifiedOn: 2026-11-14',
        '',
        '# 2026 年版改了编号的节。旧编号的 2023 文本不能按新编号引用，新编号也不能落到',
        '# 2023 索引的同名节上——两处都要标记，判定才安全。',
        'renames:',
    ]
    for rename in data['renames']:
        out.append(f'  - from: {rename["from"]}')
        out.append(f'    to: {rename["to"]}')
        out.append(f'    note: {rename["note"]}')
    out.append('')
    out.append('# 2026 年版新增的节，2023 索引中没有对应条目。')
    out.append('added:')
    for item in data['added']:
        out.append(f'  - path: {item["path"]}')
        if item.get('title'):
            out.append(f'    title: {item["title"]}')
        if item.get('note'):
            out.append(f'    note: {item["note"]}')
        lines = item.get('newColumnText') or []
        if lines:
            out.append('    newColumnText: |-')
            out.extend(f'      {line}' for line in lines)
        else:
            out.append('    newColumnText: null')
    out.append('')
    out.append('changePoints:')
    for point in data['changePoints']:
        overrides = curated.get(point['path'], {})
        kind = overrides.get('kind') or point['kind']
        note = overrides.get('note') or point['note']
        out.append(f'  - path: {point["path"]}')
        if point['title']:
            out.append(f'    title: {point["title"]}')
        out.append(f'    kind: {kind}')
        if note:
            out.append(f'    note: {note}')
        for field_name, key in (('oldColumnText', 'oldColumnText'), ('newColumnText', 'newColumnText')):
            lines = point[key]
            if lines:
                out.append(f'    {field_name}: |-')
                out.extend(f'      {line}' for line in lines)
            else:
                out.append(f'    {field_name}: null')
        out.append('')
    return '\n'.join(out).rstrip('\n') + '\n'


def read_curated(path: Path) -> dict[str, dict]:
    """The hand-verified kind and note of each recorded change point."""
    if not path.exists():
        return {}
    curated: dict[str, dict] = {}
    path_name = None
    for line in path.read_text(encoding='utf-8').split('\n'):
        match = re.match(r'^  - path: (\S+)$', line)
        if match:
            path_name = match.group(1)
            curated[path_name] = {}
            continue
        if path_name is None:
            continue
        for field_name in ('kind', 'note'):
            prefix = f'    {field_name}: '
            if line.startswith(prefix):
                curated[path_name][field_name] = line[len(prefix):].strip()
    return curated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--check', action='store_true', help='比对资产与源 PDF（默认）')
    parser.add_argument('--write', action='store_true', help='按源 PDF 重写资产')
    parser.add_argument('--pdf', type=Path, default=PDF_DEFAULT, help='官方修改对照表 PDF')
    parser.add_argument('--yaml', type=Path, default=YAML_DEFAULT, help='随包改动点资产')
    args = parser.parse_args()

    if not args.pdf.exists():
        print(f'guideline-changes: 未核验——源 PDF 不在 {args.pdf}；资产中的改动点未与本机源比对',
              file=sys.stderr)
        return
    data = read_changes(args.pdf)
    curated = read_curated(args.yaml)
    rendered = render(data, curated)
    if args.write:
        args.yaml.write_text(rendered, encoding='utf-8')
        print(f'已写入 {args.yaml}：{len(data["changePoints"])} 个改动点、'
              f'{len(data["renames"])} 处改编号、{len(data["added"])} 个新增节')
        return
    current = args.yaml.read_text(encoding='utf-8') if args.yaml.exists() else ''
    if current == rendered:
        print(f'一致：{len(data["changePoints"])} 个改动点与源 PDF 抽取结果相同')
        return
    fail(f'{args.yaml} 与源 PDF 的抽取结果不一致；运行 --write 重写')


if __name__ == '__main__':
    main()
