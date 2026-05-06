import { useState, useRef, useEffect } from 'react';
import { DEFAULT_CATEGORY_ORDER } from './useSettings.js';

export function useDragSort({ expenses, settings, updateSettings, isDark }) {
  const tableDragIndex   = useRef(null);
  const touchDragRef     = useRef({ active: false, fromIdx: null });
  const touchDragOverRef = useRef(null);
  const [tableDragOver, setTableDragOver] = useState(null);
  const [tableDragging, setTableDragging] = useState(null);

  const buildNewOrder = (fromIdx, toIdx) => {
    const currentOrder = expenses.map(ex => ex.name);
    const [moved] = currentOrder.splice(fromIdx, 1);
    currentOrder.splice(toIdx, 0, moved);
    const full = [...currentOrder];
    (settings.categoryOrder || DEFAULT_CATEGORY_ORDER).forEach(n => {
      if (!full.includes(n)) full.push(n);
    });
    return full;
  };

  const handleTableDragStart = (e, idx) => {
    tableDragIndex.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    setTableDragging(idx);
    const ghost = e.currentTarget.cloneNode(true);
    ghost.style.cssText = `
      position:fixed; top:-1000px; left:0; width:${e.currentTarget.offsetWidth}px;
      background:${isDark ? '#1e293b' : '#ffffff'};
      opacity:0.95; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.25);
      pointer-events:none;
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    setTimeout(() => document.body.removeChild(ghost), 0);
  };

  const handleTableDragOver = (e, idx) => {
    e.preventDefault();
    setTableDragOver(idx);
  };

  const handleTableDrop = (e, dropIdx) => {
    e.preventDefault();
    const from = tableDragIndex.current;
    if (from == null || from === dropIdx) { setTableDragOver(null); return; }
    updateSettings(prev => ({ ...prev, categoryOrder: buildNewOrder(from, dropIdx) }));
    tableDragIndex.current = null;
    setTableDragOver(null);
  };

  const handleTableDragEnd = () => {
    tableDragIndex.current = null;
    setTableDragOver(null);
    setTableDragging(null);
  };

  const handleGripTouchStart = (e, idx) => {
    touchDragRef.current = { active: true, fromIdx: idx };
    touchDragOverRef.current = idx;
    setTableDragging(idx);
  };

  const commitTouchDrop = () => {
    const from = touchDragRef.current.fromIdx;
    const to   = touchDragOverRef.current;
    if (from != null && to != null && from !== to) {
      updateSettings(s => ({ ...s, categoryOrder: buildNewOrder(from, to) }));
    }
    touchDragRef.current = { active: false, fromIdx: null };
    touchDragOverRef.current = null;
    setTableDragging(null);
    setTableDragOver(null);
  };

  // Non-passive touchmove — prevents page scroll while dragging rows
  useEffect(() => {
    if (tableDragging === null) return;
    const onMove = (e) => {
      if (!touchDragRef.current.active) return;
      e.preventDefault();
      const touch = e.touches[0];
      const rows = document.querySelectorAll('[data-rowindex]');
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          const overIdx = parseInt(row.getAttribute('data-rowindex'), 10);
          if (overIdx !== touchDragOverRef.current) {
            touchDragOverRef.current = overIdx;
            setTableDragOver(overIdx);
          }
          break;
        }
      }
    };
    const onEnd = () => commitTouchDrop();
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    return () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [tableDragging]);

  return {
    tableDragOver,
    tableDragging,
    handleTableDragStart,
    handleTableDragOver,
    handleTableDrop,
    handleTableDragEnd,
    handleGripTouchStart,
  };
}
