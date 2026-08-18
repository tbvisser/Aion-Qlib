# Copyright (c) MIT License.
"""Equal-weight strategy driven by a compiled Aion rule expression.

The strategy evaluates the rule expression per instrument at each trade step
and targets equal weight among all instruments for which the expression is
true.  It is intentionally lightweight: it reuses qlib's exchange and order
generation machinery while avoiding a full custom event-driven execution
engine.
"""
from __future__ import annotations

import copy

import pandas as pd

from qlib.backtest.decision import TradeDecisionWO
from qlib.backtest.position import Position
from qlib.backtest.signal import Signal
from qlib.data import D

from .order_generator import OrderGenWOInteract
from .signal_strategy import BaseSignalStrategy


class RuleFlowStrategy(BaseSignalStrategy):
    """Equal-weight portfolio for instruments matching a boolean expression.

    Parameters
    ----------
    rule_expr : str
        A per-instrument qlib expression that evaluates to a boolean.  When
        true, the instrument is eligible for an equal-weight position.
    topk : int, optional
        Maximum number of instruments to hold (default 50).  The strategy
        selects up to ``topk`` true instruments.
    n_drop : int, optional
        Kept for API compatibility with TopkDropoutStrategy; ignored because
        the rule expression is recomputed each bar.
    """

    def __init__(self, *, rule_expr: str, topk: int = 50, n_drop: int = 0,
                 instruments=None, benchmark: str | None = None, **kwargs):
        # Pass a dummy signal to satisfy BaseSignalStrategy; we evaluate the
        # expression ourselves so that the config does not need a model/dataset.
        super().__init__(signal=Signal(signal=pd.Series(dtype=float)), **kwargs)
        self.rule_expr = rule_expr
        self.topk = topk
        self.n_drop = n_drop
        self.instruments = instruments
        self.benchmark = benchmark
        self.order_generator = OrderGenWOInteract()

    def generate_trade_decision(self, execute_result=None):
        trade_step = self.trade_calendar.get_trade_step()
        trade_start_time, trade_end_time = self.trade_calendar.get_step_time(trade_step)
        pred_start_time, pred_end_time = self.trade_calendar.get_step_time(trade_step, shift=1)

        pred_score = self._load_rule_score(pred_start_time, pred_end_time)
        if pred_score is None or pred_score.empty:
            return TradeDecisionWO([], self)

        current_temp = copy.deepcopy(self.trade_position)
        assert isinstance(current_temp, Position)

        target_weight_position = self.generate_target_weight_position(
            score=pred_score,
            current=current_temp,
            trade_start_time=trade_start_time,
            trade_end_time=trade_end_time,
        )
        if not target_weight_position:
            return TradeDecisionWO([], self)

        order_list = self.order_generator.generate_order_list_from_target_weight_position(
            current=current_temp,
            trade_exchange=self.trade_exchange,
            risk_degree=self.get_risk_degree(trade_step),
            target_weight_position=target_weight_position,
            pred_start_time=pred_start_time,
            pred_end_time=pred_end_time,
            trade_start_time=trade_start_time,
            trade_end_time=trade_end_time,
        )
        return TradeDecisionWO(order_list, self)

    def generate_target_weight_position(self, score, current, trade_start_time, trade_end_time):
        """Equal weight among the topk instruments whose rule score is true."""
        mask = score.dropna().astype(bool)
        true_stocks = mask[mask].index.tolist()
        if not true_stocks:
            return {}
        true_stocks = true_stocks[: self.topk]
        trade_step = self.trade_calendar.get_trade_step()
        weight = self.get_risk_degree(trade_step=trade_step) / len(true_stocks)
        return {stock: weight for stock in true_stocks}

    def _load_rule_score(self, start_time, end_time):
        """Evaluate ``rule_expr`` and return a series indexed by instrument."""
        try:
            codes = self.instruments
            if codes is None:
                codes = getattr(self.trade_exchange, "codes", None)
            if codes is None:
                return None
            freq = getattr(self.trade_exchange, "freq", None)
            df = D.features(
                codes,
                [self.rule_expr],
                start_time=start_time,
                end_time=end_time,
                freq=freq,
            )
        except Exception:
            return None
        if df.empty:
            return None
        score = df.iloc[:, 0]
        if isinstance(score.index, pd.MultiIndex) and "datetime" in score.index.names:
            score = score.droplevel("datetime")
        return score.astype(float)
