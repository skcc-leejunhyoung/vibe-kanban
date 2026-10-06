import { ElementTransformer, TRANSFORMERS } from '@lexical/markdown';
import {
  TableNode,
  TableRowNode,
  TableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableCellNode,
  TableCellHeaderStates,
} from '@lexical/table';
import { $markdownToEditor } from './markdown';

const TABLE_ROW_REG_EXP = /^(?:\|)(.+)(?:\|)\s?$/;
const TABLE_ROW_DIVIDER_REG_EXP = /^(\| ?:?-+:? ?)+\|\s?$/;

function $createTableCell(textContent: string): TableCellNode {
  textContent = textContent.replace(/\\n/g, '\n');
  const cell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
  $markdownToEditor(textContent, TRANSFORMERS, cell);
  return cell;
}

function mapToTableCells(textContent: string): Array<TableCellNode> | null {
  // Keep empty cells: dropping them shifts every later column left.
  const cells = textContent.split('|').map((c) => c.trim());
  return cells.map($createTableCell);
}

export const TABLE_TRANSFORMER: ElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  type: 'element',
  regExp: TABLE_ROW_REG_EXP,

  export: (node, traverseChildren) => {
    if (!$isTableNode(node)) return null;

    const output: string[] = [];
    const children = node.getChildren();

    for (let i = 0; i < children.length; i++) {
      const row = children[i];
      if (!$isTableRowNode(row)) continue;

      const cells = row.getChildren();
      const cellTexts = cells.map((cell) => {
        if (!$isTableCellNode(cell)) return '';
        return traverseChildren(cell).replace(/\n/g, '\\n');
      });

      output.push('| ' + cellTexts.join(' | ') + ' |');

      // Add header divider after first row if it contains header cells
      if (i === 0) {
        const isHeader = cells.some(
          (cell) =>
            $isTableCellNode(cell) &&
            cell.getHeaderStyles() !== TableCellHeaderStates.NO_STATUS
        );
        if (isHeader || children.length > 1) {
          output.push('| ' + cellTexts.map(() => '---').join(' | ') + ' |');
        }
      }
    }

    return output.join('\n');
  },

  replace: (parentNode, _children, match) => {
    // Handle header divider detection. Use the matched line: by the time
    // replace() runs, the importer has already stripped the match from the
    // paragraph, so its text content is empty and a divider would be read as
    // a data row of "---" cells (one more per save).
    if (TABLE_ROW_DIVIDER_REG_EXP.test(match[0])) {
      // Find previous sibling and mark as header
      const prevSibling = parentNode.getPreviousSibling();
      if ($isTableNode(prevSibling)) {
        const firstRow = prevSibling.getFirstChild();
        if ($isTableRowNode(firstRow)) {
          firstRow.getChildren().forEach((cell) => {
            if ($isTableCellNode(cell)) {
              cell.setHeaderStyles(TableCellHeaderStates.ROW);
            }
          });
        }
      }
      parentNode.remove();
      return;
    }

    // Parse row cells
    const cells = mapToTableCells(match[1]);
    if (!cells) return;

    const tableRow = $createTableRowNode();
    cells.forEach((cell) => tableRow.append(cell));

    // Check if previous sibling is a table to merge into
    const prevSibling = parentNode.getPreviousSibling();
    if ($isTableNode(prevSibling)) {
      prevSibling.append(tableRow);
      parentNode.remove();
    } else {
      // Create new table
      const table = $createTableNode();
      table.append(tableRow);
      parentNode.replace(table);
    }
  },
};
