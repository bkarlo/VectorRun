This is actually a very good domain for AI-assisted analysis because orienteering is fundamentally about decision quality under uncertainty, not just speed.

I would not build “another GPX viewer”. I would build a coach that understands route choices.

Vision

VectorRun = GitHub for orienteering routes.

Instead of comparing code commits, you compare route decisions.

Every training session becomes something that can be replayed, analyzed, discussed and learned from.

⸻

Workflow

Before training

Trainer creates an event.

* uploads map (PDF/OMap/OCAD)
* creates course
* enters controls
* optionally uploads “ideal route”
* sets exercise type
    * normal course
    * route choice
    * compass
    * corridor
    * one-man relay
    * memory-O
    * etc.

Participants join.

⸻

After training

Everyone uploads

* GPX
* FIT
* Garmin activity
* COROS
* Strava
* Apple Watch
* Suunto

VectorRun automatically aligns everything.

Instead of absolute GPS, everything becomes

Position on the map.

⸻

Main screen

Imagine something similar to Figma.

Left:

List of runners

☑ Peter
☑ Anna
☑ Tom
☑ Kate
☑ Me

Center

Map.

Colored tracks.

Right

Analysis panel.

⸻

Time synchronization

One huge challenge:

Nobody starts exactly together.

System should synchronize automatically.

Options

* synchronize by start punch
* synchronize by first control
* manually
* by best fit algorithm

Then allow

“Replay”

Time slider.

Watch everybody moving simultaneously.

Like:

00:00
Peter →
Anna  →
Tom
00:45
Peter already climbing
Anna choosing road
Tom still in green forest

This alone is extremely useful.

⸻

Leg analysis

This becomes the heart.

For every leg

5 -> 6

Show

Runner	Time	Distance	Climb
Peter	1:58	420 m	15 m
Anna	2:15	460 m	5 m
Tom	2:04	510 m	0

⸻

Then

Draw every route.

Overlay.

Instantly visible

Left route

Right route

Straight

Road

Forest

⸻

Automatic route clustering

Very interesting AI feature.

Instead of listing 9 runners

Cluster

Route A
Peter
Tom
John
Route B
Anna
Kate
Route C
Mike

Then compare

Average time

Average speed

Mistakes

Distance

⸻

Detect hesitation

GPX contains speed.

Detect

Low speed
Direction changes
Stopping
Circling

Highlight

“Possible hesitation”

Maybe

Leg 8
Peter hesitated
for 19 seconds

⸻

Mistake detection

Automatically classify mistakes.

Examples

Parallel error

Running on wrong reentrant.

Overshoot

Passed control.

Relocation

Stopped.

Looked around.

Found attack point.

Wrong attack point

Wrong contour

Bad compass

Green avoidance

Hill avoidance

⸻

Heatmap

Overlay everybody.

See

95% chose left.
One runner chose right.

⸻

Time lost estimation

Interesting algorithm.

Estimate

Actual
3:25
Without hesitation
2:52
Estimated loss
33 s

Not perfect.

Still useful.

⸻

Split ranking

Instead of whole race

Rank every leg.

Leg 4
Peter
1
Anna
2
Tom
3

⸻

Speed profile

Not just speed.

Separate

Running speed

Walking

Standing

Searching

⸻

Terrain classification

If map is georeferenced

Calculate

Time spent

Open
Forest
Green
Marsh
Path
Contour climbing

Then

Peter
40% on path
Anna
15%
Tom
0%

Interesting coaching insight.

⸻

Route choice simulator

Suppose Anna was 18 seconds slower.

System asks

“What if Anna had taken Peter’s route?”

Estimate

Expected
-12 seconds

⸻

Replay mode

This could become addictive.

Like football replay.

Slider.

Pause.

Zoom.

Trail behind runners.

Control circles.

Current ranking.

Gap.

⸻

AI Coach

This is where modern LLMs become valuable.

Instead of charts:

Leg 6–7: You lost approximately 28 seconds. The main cause was not the longer route but hesitation after crossing the marsh. Your pace dropped from 4.5 m/s to 1.2 m/s while making three significant heading changes. A clearer attack point from the boulder west of the control would likely have prevented this.

Much more useful.

⸻

Compare yourself

Select

Me
vs
Peter

System generates

Difference report

Timeline

0:20
Same
0:48
Peter takes trail
You go straight
1:30
Routes merge
Gap +9 s

⸻

Session dashboard

Trainer sees

12 runners
Fastest
Peter
Most efficient routes
Anna
Biggest improvement
Tom
Hardest leg
8 -> 9
Average mistake
42 seconds
Most common mistake
Wrong attack point

⸻

Long-term statistics

After 30 trainings

Average climb speed
Compass accuracy
Hesitation frequency
Average relocation time
Mistakes per km
Route choice quality
Control approach quality
Navigation confidence score

This becomes incredibly valuable.

⸻

AI-generated exercises

After analyzing months of training

VectorRun could recommend targeted sessions:

“Your largest recurring weakness is contour interpretation on mid-length legs (200–500 m). We recommend a contour-only exercise with reduced path visibility.”

Or:

“The group consistently loses time entering dense vegetation. Consider a control-picking session focused on attack-point selection.”

This closes the feedback loop from analysis to deliberate practice.

Technical architecture

I would structure the system around a processing pipeline:

1. Data ingestion: GPX/FIT/TCX imports from watches and phones.
2. Map alignment: Transform GPS coordinates into map coordinates using a georeferenced map or manually defined control points.
3. Leg segmentation: Automatically split tracks into legs based on control locations or punch data.
4. Feature extraction: Compute metrics such as speed, heading changes, climb, pauses, distance, terrain transitions, and deviations from the optimal line.
5. Analysis engine: Detect route choices, hesitation, mistakes, and similarities between runners.
6. AI layer: Generate coaching summaries, compare performances, answer natural-language questions (“Where did I lose the most time today?”).
7. Visualization: Interactive replay, overlays, dashboards, and reports.

What would differentiate VectorRun?

Many existing tools (such as Livelox, QuickRoute, and RouteGadget) already provide GPS replay and route overlays. To stand out, VectorRun should focus on capabilities they either lack or only partially support:

* Automatic route clustering rather than manual visual comparison.
* Per-leg AI coaching that explains why time was lost.
* Automatic mistake classification (hesitation, overshoot, relocation, poor attack point, etc.).
* Training progression analytics across months or seasons.
* Trainer-centric insights, identifying patterns across the whole group rather than individual performances.
* Natural-language querying, for example:
    * “Show every leg where I lost more than 20 seconds because of hesitation.”
    * “Which runner consistently chose the best route through green vegetation?”
    * “Which control generated the greatest variation in route choice today?”

Those features would move VectorRun from being a visualization tool to becoming an intelligent coaching platform.

⸻

## Implementation milestones

### Milestone 1A — Session workspace (shipped)

Events, optional georeferenced map, controls, GPX upload, sync strategies, multi-runner replay, speed chart, and per-leg splits (time / distance / climb / pace).

### Milestone 1B — Leg storytelling (shipped)

Per-leg corridor, hesitation, peer-anchored decision signals, Overall S→F via ordered course punches.

### Milestone 1B+ — Training day plan (current)

Ordered **day phases** (transit / rest / course) so one GPX can hold walk-in, several mini-courses (including the same loop twice), rest at base, and walk-back. Setup separates **Controls** from **Define the day**. Race window spans first course S → last course F.

### Milestone 1C — Clustering + AI coach (next)

* Route clustering / medoids so multiple valid choices are not flagged as “wrong.”
* Richer mistake taxonomy and “what if you took X’s route” comparison.
* Natural-language coaching on top of the 1B feature fields.
