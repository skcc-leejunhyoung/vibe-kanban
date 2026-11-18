import { renderToStaticMarkup } from 'react-dom/server';
import { DragDropContext, Droppable } from '@hello-pangea/dnd';
import { describe, expect, it } from 'vitest';
import { IssueListRow } from '@vibe/ui/components/IssueListRow';

function render(isMultiSelectActive = false, isChecked = false) {
  return renderToStaticMarkup(
    <DragDropContext onDragEnd={() => {}}>
      <Droppable droppableId="synthetic-list">
        {(provided) => (
          <div ref={provided.innerRef} {...provided.droppableProps}>
            <IssueListRow
              issue={{
                id: 'synthetic-issue',
                simple_id: 'DEMO-101',
                title: 'Synthetic issue',
                priority: null,
                created_at: '2030-01-01T00:00:00Z',
              }}
              index={0}
              statusColor="200 50% 50%"
              tags={[]}
              assignees={[]}
              onClick={() => {}}
              isSelected={false}
              isMultiSelectActive={isMultiSelectActive}
              isChecked={isChecked}
            />
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}

describe('issue list selection affordance', () => {
  it('omits the checkbox outside multi-select mode, including a single checked row', () => {
    for (const checked of [false, true]) {
      const html = render(false, checked);
      expect(html).toContain('Synthetic issue');
      expect(html).not.toContain('role="checkbox"');
    }
  });

  it.each([false, true])(
    'shows the checkbox in multi-select mode (checked=%s)',
    (checked) => {
      const html = render(true, checked);
      expect(html).toContain('role="checkbox"');
      expect(html).toContain(`aria-checked="${checked}"`);
      expect(html).toContain('aria-label="Select DEMO-101"');
    }
  );
});
