import React from 'react';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import { Move } from 'lucide-react';
import { DEFAULT_LAYOUT } from './useSettings.js';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

export const TILE_LABELS = {
  'stat-cards':    'Summary Cards',
  'expense-table': 'Expense Breakdown',
  'donut-chart':   'Spending Distribution',
  'bar-chart':     'Actual vs Budget',
  'insight-cards': 'Insight Cards',
  'non-monthly':   'Non-Monthly Expenses',
  'budget-rules':  '50/30/20 Rules',
};

export function DashboardGrid({ layout, editLayout, onLayoutChange, tiles }) {
  const { containerRef, width: containerWidth } = useContainerWidth();

  return (
    <div ref={containerRef}>
      {editLayout && (
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="w-2 h-2 rounded-full animate-pulse flex-shrink-0" style={{ background: 'var(--color-accent)' }} />
          <p className="text-xs font-bold" style={{ color: 'var(--color-accent-text)' }}>
            Layout editing — drag tiles to move, pull the corner handle to resize
          </p>
        </div>
      )}

      <GridLayout
        layout={layout}
        onLayoutChange={onLayoutChange}
        width={containerWidth || 1200}
        cols={12}
        rowHeight={60}
        isDraggable={editLayout}
        isResizable={editLayout}
        draggableHandle=".tile-handle"
        margin={[16, 16]}
        containerPadding={[0, 0]}
        compactType="vertical"
        useCSSTransforms
      >
        {layout.map(item => (
          <div
            key={item.i}
            className="flex flex-col overflow-hidden rounded-[2rem] transition-all"
            style={editLayout ? {
              outline: '2px solid var(--color-accent-border)',
              boxShadow: '0 8px 32px var(--color-accent-subtle)',
            } : {}}
          >
            {/* Drag handle — only in edit mode */}
            {editLayout && (
              <div
                className="tile-handle flex-shrink-0 flex items-center gap-2 px-4 py-2.5 text-white text-xs font-bold cursor-grab active:cursor-grabbing select-none rounded-t-[2rem]"
                style={{ background: 'var(--color-accent)' }}
              >
                <Move className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{TILE_LABELS[item.i] || item.i}</span>
                <span className="ml-auto text-[10px] hidden sm:block whitespace-nowrap" style={{ opacity: 0.7 }}>
                  drag · resize ↘
                </span>
              </div>
            )}

            {/* Content */}
            <div className={`flex-1 min-h-0 overflow-auto ${editLayout ? 'pointer-events-none opacity-70' : ''}`}>
              {tiles[item.i]}
            </div>
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
