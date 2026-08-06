# 0.018站所更名與資料遷移規格

## 映射表

- `CS2` → `CT2`
- `CS5` → `CT5`
- `CS6` → `CT6`
- `SS4` → `ST4`
- `SS5` → `ST5`
- `SS6` → `ST6`
- `KS2` → `KT2`
- `TS2` → `TT2`
- `TS6` → `TT6`
- `NS3` → `NT3`
- `NS8` → `NT8`
- `NS9` → `NT9`
- `NS10` → `NT10`
- `NS11` → `NT11`
- `NS12` → `NT12`
- `NS13` → `NT13`
- `NS16` → `NT16`
- `NS17` → `NT17`
- `NS19` → `NT19`
- `NS20` → `NT20`
- `NS21` → `NT21`
- `NS22` → `NT22`
- `NS23` → `NT23`

## 遷移範圍

- `shift.events[].station`
- `shift.actualConfirmed`的`站所:載具`鍵
- App UI中的盤點展開站所
- App UI中的事件站所篩選
- 舊JSON匯入
- 核心新增、直接輸入與事件編輯API

## 不變項目

- 班次ID與日期
- 事件ID、operationId、時間與備註
- 類別、載具、delta與after重算結果
- 回倉來源（CS4仍為CS4）
- 計算公式
- 低亮度語意色盤
