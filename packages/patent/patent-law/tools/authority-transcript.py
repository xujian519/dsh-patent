#!/usr/bin/env python3
"""Transcribe the patent judicial interpretations and departmental regulations into the article index.

《专利审查指南》之外的专利法源没有随包的合订 PDF：本仓库的做法是把知识库原件的
Markdown 转录成 `assets/law/` 下的条级索引，一份文书一个文件。司法解释与部门规章的
原文按「第X条」分条，因此可以机械转录：

- 去掉 markdown 的 `**` 强调与引用块 `>` 前缀；
- 以 `第X条` 行开始一条，条文到下一个同级标记或章标题为止；
- 官方文本不分条的批复与行业标准登记为第一条，并在文件头写明；
- 条文的 `topics` 取首句：截到第一个句读（。；，）并去掉开头的主语套话，未经人工
  核定；主题词只用于命题匹配，条文正文才是判定依据。

用法：
  python3 tools/authority-transcript.py --check
  python3 tools/authority-transcript.py --write

源文件不在仓库中，缺失时脚本报「未核验」而不是静默通过；每个索引文件头记录源文件的
SHA-256，`--check` 同时比对哈希与逐条正文。
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

ASSETS = Path(__file__).resolve().parent.parent / 'assets/law'
CORPUS = Path('/Users/xujian/projects/宝宸知识库_Raw')


@dataclass(frozen=True)
class Document:
    """One interpretation: where its text lives and how the index labels it."""

    file: str
    output: str
    law: str
    document: str
    revision: str
    source: str
    note: str = ''


DOCUMENTS = (
    Document(
        '法律法规司法解释/最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）_20200910.md',
        'cn-interpretation-patent-grant-confirmation.yaml',
        '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）',
        '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）',
        '法释〔2020〕8号（2020-09-12 施行）',
        '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）',
    ),
    Document(
        '法律法规司法解释/最高人民法院关于审理专利纠纷案件适用法律问题的若干规定_20201229.md',
        'cn-interpretation-patent-disputes.yaml',
        '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定',
        '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定',
        '2001 年公布，2020 年第三次修正（2021-01-01 施行）',
        '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定',
    ),
    Document(
        '法律法规司法解释/最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释_20091228.md',
        'cn-interpretation-infringement.yaml',
        '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
        '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
        '法释〔2009〕21号（2010-01-01 施行）',
        '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
    ),
    Document(
        '法律法规司法解释/最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）_20201229.md',
        'cn-interpretation-infringement-2.yaml',
        '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）',
        '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）',
        '2016 年公布，2020 年修正（2021-01-01 施行）',
        '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）',
    ),
    Document(
        '法律法规司法解释/最高人民法院关于审理涉专利权评价报告案件适用法律问题的批复_20250730.md',
        'cn-interpretation-patent-evaluation-report.yaml',
        '最高人民法院关于审理涉专利权评价报告案件适用法律问题的批复',
        '最高人民法院关于审理涉专利权评价报告案件适用法律问题的批复',
        '法释〔2025〕11号（2025-08-01 施行）',
        '最高人民法院关于审理涉专利权评价报告案件适用法律问题的批复',
        '批复不分条，全文登记为第一条。',
    ),
    Document(
        '法律法规司法解释/最高人民法院关于审理申请注册的药品相关的专利权纠纷民事案件适用法律若干问题的规定_20210704.md',
        'cn-interpretation-drug-patent-disputes.yaml',
        '最高人民法院关于审理申请注册的药品相关的专利权纠纷民事案件适用法律若干问题的规定',
        '最高人民法院关于审理申请注册的药品相关的专利权纠纷民事案件适用法律若干问题的规定',
        '法释〔2021〕13号（2021-07-05 施行）',
        '最高人民法院关于审理申请注册的药品相关的专利权纠纷民事案件适用法律若干问题的规定',
    ),
    Document(
        '法律法规司法解释/最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释（法释〔2026〕7号）.md',
        'cn-interpretation-punitive-damages.yaml',
        '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释',
        '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释',
        '法释〔2026〕7号（2026-05-01 施行）',
        '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释',
    ),
    Document(
        '规章/专利代理管理办法.md',
        'cn-regulation-patent-agency.yaml',
        '专利代理管理办法',
        '专利代理管理办法',
        '国家市场监督管理总局令第6号（2019-05-01 施行）',
        '专利代理管理办法',
    ),
    Document(
        '规章/专利实施强制许可办法.md',
        'cn-regulation-compulsory-license.yaml',
        '专利实施强制许可办法',
        '专利实施强制许可办法',
        '国家知识产权局令第64号（2012-05-01 施行）',
        '专利实施强制许可办法',
    ),
    Document(
        '规章/专利权质押登记办法.md',
        'cn-regulation-patent-pledge.yaml',
        '专利权质押登记办法',
        '专利权质押登记办法',
        '国家知识产权局令第56号（2010-10-01 施行）',
        '专利权质押登记办法',
    ),
    Document(
        '规章/专利标识标注办法.md',
        'cn-regulation-patent-marking.yaml',
        '专利标识标注办法',
        '专利标识标注办法',
        '国家知识产权局令第63号（2012-05-01 施行）',
        '专利标识标注办法',
    ),
    Document(
        '规章/专利行政执法办法.md',
        'cn-regulation-patent-enforcement.yaml',
        '专利行政执法办法',
        '专利行政执法办法',
        '国家知识产权局令第60号公布，第71号修正（2011-02-01 施行）',
        '专利行政执法办法',
    ),
    Document(
        '规章/关于规范专利申请行为的若干规定.md',
        'cn-regulation-application-conduct.yaml',
        '关于规范专利申请行为的若干规定',
        '关于规范专利申请行为的若干规定',
        '国家知识产权局令第45号（2007-10-01 施行）',
        '关于规范专利申请行为的若干规定',
    ),
    Document(
        '规章/用于专利程序的生物材料保藏办法.md',
        'cn-regulation-biological-material.yaml',
        '用于专利程序的生物材料保藏办法',
        '用于专利程序的生物材料保藏办法',
        '国家知识产权局令第69号（2015-03-01 施行）',
        '用于专利程序的生物材料保藏办法',
    ),
    Document(
        '规章/专利申请号标准.md',
        'cn-regulation-application-number-standard.yaml',
        '专利申请号标准',
        '专利申请号标准',
        'ZC 0006-2003（国家知识产权局令第32号，2003-10-01 施行）',
        '专利申请号标准',
        '行业标准不分条，按编号条款编排（1 范围、2.1 专利申请……），全文登记为第一条。',
    ),
)

NUMERALS = '〇零一二三四五六七八九十百'
ARTICLE = re.compile(rf'^\*{{0,2}}第([{NUMERALS}0-9]+)条\*{{0,2}}[\s　]*(.*)$')
CHAPTER = re.compile(rf'^#{{0,3}}\s*第[{NUMERALS}]+章')
DIGITS = {'〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
def fail(message: str) -> NoReturn:
    """Exit with a concise, user-correctable error."""
    print(f'authority-transcript: {message}', file=sys.stderr)
    raise SystemExit(1)


def numeral(text: str) -> int:
    """Read a Chinese or ASCII article number."""
    if text.isdigit():
        return int(text)
    total = section = 0
    for char in text:
        if char == '百':
            total += (section or 1) * 100
            section = 0
        elif char == '十':
            total += (section or 1) * 10
            section = 0
        else:
            section = DIGITS[char]
    return total + section


def clean(line: str) -> str:
    """Strip the markdown carriers around one source line."""
    line = line.replace('**', '').rstrip()
    if line.startswith('>'):
        line = line.lstrip('>').strip()
    return line.strip()


def topics_of(text: str) -> list[str]:
    """The mechanical topic keyword: the article's opening clause."""
    clause = re.split(r'[。；，：:\n]', text, maxsplit=1)[0].strip('，。；：、')
    if len(clause) > 24:
        clause = clause[:24]
    return [clause or text[:24]]


def parse(text: str, note: str) -> list[dict]:
    """Split one document into article entries, one source line per paragraph."""
    body = text.split('<!-- INFO END -->')[-1]
    articles: list[dict] = []
    current: dict | None = None
    for raw in body.split('\n'):
        line = clean(raw)
        if line in ('', '---') or CHAPTER.match(line):
            continue
        match = ARTICLE.match(line)
        if match:
            number = numeral(match.group(1))
            # 条文正文会引用别的条（「……违反本办法第二十七条规定」），折行后
            # 引用可能落在行首。条号必须紧接上一条，否则这行是正文。
            expected = articles[-1]['article'] + 1 if articles else 1
            if number == expected:
                current = {'article': number, 'lines': []}
                if match.group(2):
                    current['lines'].append(match.group(2).strip())
                articles.append(current)
                continue
            if articles:
                articles[-1]['lines'].append(line)
                continue
        if current is not None:
            current['lines'].append(line)
    if not articles:
        # 批复不分条：全文登记为第一条。
        lines = [clean(raw) for raw in text.split('\n')]
        paragraph = ''.join(
            line for line in lines
            if line and not line.startswith('#') and line not in ('---', '<!-- INFO END -->')
        )
        return [{'article': 1, 'lines': [paragraph], 'note': note, 'documentLevel': True}]
    for article in articles:
        if not article['lines']:
            fail(f'第{article["article"]}条没有正文')
    return articles


def render(document: Document, sha256: str, articles: list[dict]) -> str:
    """Render one index file."""
    header = [
        f'# {document.law} — 随包条级索引。',
        '#',
        '# 条文按知识库原件的 Markdown 机械转录，逐字保留原文；转录日期见每条 verifiedOn。',
        f'# 源文件：{document.file}（SHA-256 {sha256}）。',
        '#',
        '# 主题词（topics）取条文首句的第一个分句，未经人工核定：主题词只作命题匹配的线索，',
        '# 判定依据是条文正文。源文件开头的制定目的段（引用块引言）未登记，本索引只收条文。',
    ]
    if document.note:
        header.append(f'# {document.note}')
    lines = header + [
        '',
        f'law: {document.law}',
        f'document: {document.document}',
        f'revision: {document.revision}',
        f'maxArticle: {max(article["article"] for article in articles)}',
        'maxVerifiedOn: 2026-11-14',
        f"maxSource: '{document.source}（知识库原件 Markdown 机械转录）'",
        'articles:',
    ]
    for article in articles:
        text = '\n'.join(article['lines'])
        lines.append(f'  - article: {article["article"]}')
        topics = [document.document] if article.get('documentLevel') else topics_of(text)
        lines.append(f'    topics: [{", ".join(scalar(topic) for topic in topics)}]')
        lines.extend(render_text(text))
        lines.append(f"    sourceDoc: '{document.source}（知识库原件 Markdown）'")
        lines.append('    verifiedOn: 2026-11-14')
        lines.append('')
    return '\n'.join(lines).rstrip('\n') + '\n'


def scalar(text: str) -> str:
    """Quote a topic so a colon or comma in the clause keeps the flow list valid."""
    if any(char in text for char in ':,[]{}#&*!|>\'"%@`') or text != text.strip():
        return "'" + text.replace("'", "''") + "'"
    return text


def render_text(text: str) -> list[str]:
    """One article's body as a YAML literal block, one paragraph per line."""
    if '\n' not in text:
        return [f"    text: '{text}'"] if "'" not in text else [f'    text: "{text}"']
    return ['    text: |-'] + [f'      {line}' for line in text.split('\n')]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--check', action='store_true', help='比对索引与源文件（默认）')
    parser.add_argument('--write', action='store_true', help='按源文件重写索引')
    parser.add_argument('--corpus', type=Path, default=CORPUS, help='知识库根目录')
    args = parser.parse_args()

    missing = [document.file for document in DOCUMENTS if not (args.corpus / document.file).exists()]
    if missing:
        print(f'authority-transcript: 未核验——源文件不在 {args.corpus}：{missing[0]}',
              file=sys.stderr)
        return

    written = 0
    for document in DOCUMENTS:
        source = (args.corpus / document.file).read_bytes()
        articles = parse(source.decode('utf-8'), document.note)
        rendered = render(document, hashlib.sha256(source).hexdigest(), articles)
        target = ASSETS / document.output
        if args.write:
            target.write_text(rendered, encoding='utf-8')
            written += 1
            continue
        current = target.read_text(encoding='utf-8') if target.exists() else ''
        if current != rendered:
            fail(f'{target} 与源文件不一致；运行 --write 重写')
    if args.write:
        print(f'已写入 {written} 个索引文件')
    else:
        print(f'一致：{len(DOCUMENTS)} 份文书与源文件相同')


if __name__ == '__main__':
    main()
