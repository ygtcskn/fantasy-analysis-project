# Match probabilities and fair odds

I wanted to estimate the chance of a home win, draw, or away win before kickoff. The main modeling constraint was deciding which results and statistics would actually have been available when making each prediction.

**Skills demonstrated** · Time-aware feature engineering · Data leakage prevention · Probabilistic modeling · XGBoost

## My approach

- I used historical outcome frequencies as a baseline. The Poisson model estimates goals from each team’s attack and defense strength and home advantage. Dixon–Coles adds a correction for low-score outcomes.
- I trained an XGBoost classifier on pre-match Elo, rest days, and time-decayed rates for goals and team statistics such as shots. Each training row reconstructs league history at its own cutoff. A prior match enters those features only after its result becomes available.
- I summed the goal-model score grid into home, draw, and away probabilities. Inverting each probability gives the corresponding implied fair decimal odds.

## How I checked it

On synthetic fixtures, I fitted the frequency, Poisson, Dixon–Coles, and XGBoost models with and without a result that became available after the cutoff. All four produced the same predictions in both runs, and their outcome probabilities summed to one.

## Read the code

- `replay()` builds training rows as the clock advances. Follow the comparison between each result’s availability time and the target fixture’s cutoff. [Feature replay](../../src/odds/features.py#L392)
- `fit_model()` filters historical results at a supplied prediction time and fits the chosen model. [Model fitting](../../src/odds/models.py#L315)
- `score_probabilities()` turns expected goals into outcome probabilities. With example rates of 1.5 and 1.0, the output is 48.8% home win, 26.0% draw, and 25.2% away win. [Score grid](../../src/odds/models.py#L104)
