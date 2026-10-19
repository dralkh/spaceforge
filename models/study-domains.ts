/**
 * Spaceforge Study — domain profiles.
 *
 * The tutor has to work for cardiology, contract law, calculus, sourdough and
 * jazz harmony without being rewritten for each. The trick is that every
 * discipline has the same *shape* of pedagogy but different *content*: what
 * counts as a mechanism, what an unseen case looks like, which mistakes are
 * characteristic, and whose word counts as authoritative.
 *
 * This registry ships that content. The model only has to classify a note into
 * one of these ids (and may add subject-specific notes); the pedagogy itself
 * comes from here, which keeps behaviour predictable across models — including
 * small local ones.
 */

/**
 * How a discipline is best *seen*, not just read.
 *
 * The pedagogy above is about how to teach a subject; this is about how to draw
 * it. Medicine reasons in differentials and red flags, biochemistry in pathways
 * with a rate-limiting step, law in an ordered element test, history in
 * sequence — a mind map and a comparison matrix carry different disciplines
 * differently, and a summary has to know which details are the pearls.
 */
import { StudyVisualKind } from './study-visuals';

export interface StudyVisualProfile {
    /** Which visual board forms carry this discipline's reasoning. */
    kinds: StudyVisualKind[];
    /** How deep a mind map is worth drawing before it stops informing. */
    mapDepth: number;
    /** Summary bullets earned per objective, before the volume term. */
    bulletRatio: number;
    /** One line of field-specific condensing advice, written into the prompt. */
    condense: string;
}

export interface StudyDomainProfile {
    id: string;
    /** Shown in the UI chip. */
    label: string;
    /** Lowercase keywords used by the cheap first-pass detector. */
    hints: string[];
    /** True when a misconception can hurt someone or break something. */
    safetyCritical: boolean;
    /** What "how it works" means in this discipline. */
    mechanism: string;
    /** The canonical reasoning form the tutor should use. */
    reasoning: string;
    /** How to explain well here. */
    teach: string;
    /** What an unseen transfer task looks like here. */
    transfer: string;
    /** Characteristic mistakes, used to flavour diagnosis. */
    pitfalls: string[];
    /** Whose word counts as authoritative for a web lookup. */
    authority: string;
    /** How to treat numbers, units and notation. */
    numbers: string;
    /** Question-design cautions specific to the discipline. */
    questions: string;
    /** Extra instruction lines appended to the system prompt. */
    directives: string[];
    /** How this discipline is best drawn; see StudyVisualProfile. */
    visuals?: StudyVisualProfile;
}

const SHARED_DIRECTIVES = [
    'Never equate recognition, familiarity or agreement with mastery.',
    'Never invent sources, statistics, citations, quotes or dates.',
    'Keep each turn short enough to answer without scrolling.',
];

export const STUDY_DOMAINS: StudyDomainProfile[] = [
    {
        id: 'general',
        label: 'General topic',
        hints: [],
        safetyCritical: false,
        mechanism: 'the causal or logical chain that makes the idea work, or the reason the thing is the way it is',
        reasoning: 'plain cause → consequence → so-what chains, built one link at a time',
        teach: 'define the term, give the shortest working model of it, then a concrete example',
        transfer: 'a fresh situation the learner has not seen, requiring the idea to be used rather than recited',
        pitfalls: ['learning the label without the model behind it', 'treating one example as the rule'],
        authority: 'well-established references and primary sources',
        numbers: 'preserve every quantity, unit and condition exactly',
        questions: 'avoid questions that can be answered by guessing or by process of elimination alone',
        directives: [],
        visuals: {
            kinds: ['matrix', 'flow'],
            mapDepth: 3,
            bulletRatio: 1.1,
            condense: 'keep the definition of each idea and the one example that makes it real; drop restatements',
        },
    },
    {
        id: 'medicine',
        label: 'Medicine & health',
        hints: ['patient', 'clinical', 'diagnosis', 'symptom', 'syndrome', 'therapy', 'dose', 'medical', 'pathophysiology', 'treatment', 'طب', 'مرض', 'علاج', 'تشخيص'],
        safetyCritical: true,
        mechanism: 'pathophysiology: cause → physiological change → clinical finding → investigation → decision',
        reasoning: 'cause → mechanism → presentation → investigation → management, with the thresholds and contraindications that decide it',
        teach: 'one mechanism at a time, then contrast it with the condition it is most often confused with',
        transfer: 'an unseen vignette requiring a decision: next best test, next best step, or the reason a listed option is contraindicated',
        pitfalls: ['mixing up look-alike conditions', 'knowing the finding but not the threshold', 'omitting a contraindication under pressure'],
        authority: 'current clinical guidelines and peer-reviewed literature; flag anything time-sensitive',
        numbers: 'preserve doses, thresholds, cut-offs, units and denominators exactly — never round a decision boundary',
        questions: 'every distractor must be plausible-but-wrong for a stated reason; avoid ambiguous keys',
        directives: [
            'Flag dangerous misconceptions immediately and unmistakably.',
            'Treat anything said in the source that conflicts with current practice as an inconsistency to surface, not to silently correct.',
        ],
        visuals: {
            kinds: ['matrix', 'flow', 'cycle'],
            mapDepth: 3,
            bulletRatio: 1.2,
            condense: 'keep the discriminators between look-alikes, the red flags and the first-line action; drop epidemiology and historical detail',
        },
    },
    {
        id: 'life-sciences',
        label: 'Life sciences',
        hints: ['cell', 'protein', 'gene', 'enzyme', 'neuron', 'dna', 'rna', 'ecosystem', 'evolution', 'organism', 'biology', 'أحياء', 'خلية', 'وراثة'],
        safetyCritical: false,
        mechanism: 'the biological pathway: structure → function → regulation, at the level of molecules, cells or organisms',
        reasoning: 'structure → function → regulation → consequence at the next level up',
        teach: 'anchor every name to what the thing does and what it acts on; use one diagram-in-words per concept',
        transfer: 'predict the outcome of a change to one part of the system (knockout, inhibitor, mutation, perturbation)',
        pitfalls: ['confusing similar molecules or pathways', 'learning directions of flow backwards', 'treating a diagram as the mechanism'],
        authority: 'peer-reviewed literature and standard textbooks',
        numbers: 'preserve concentrations, affinities, sizes and stoichiometries exactly',
        questions: 'test direction, order and causality, not just the names of the parts',
        directives: [],
        visuals: {
            kinds: ['cycle', 'flow', 'matrix'],
            mapDepth: 4,
            bulletRatio: 1.2,
            condense: 'keep the substrates, the enzymes and above all the regulated, rate-limiting step of each pathway; drop structural minutiae',
        },
    },
    {
        id: 'physical-sciences',
        label: 'Physics & chemistry',
        hints: ['force', 'energy', 'momentum', 'velocity', 'reaction', 'molecule', 'thermodynamic', 'quantum', 'electron', 'atom', 'chemistry', 'physics', 'فيزياء', 'كيمياء'],
        safetyCritical: false,
        mechanism: 'the physical process, stated with the quantity that governs it and the direction it acts in',
        reasoning: 'principle → governing relation → sign/direction → numerical or limiting answer',
        teach: 'state the principle, then show it operating in the simplest possible system before adding realism',
        transfer: 'an unfamiliar arrangement requiring the governing relation to be selected and applied, including limits and boundary cases',
        pitfalls: ['sign and direction errors', 'confusing a special case for the general law', 'plugging numbers in before identifying the principle'],
        authority: 'standard references and peer-reviewed literature',
        numbers: 'units and significant figures are part of the answer; preserve them exactly',
        questions: 'include at least one item where the tempting shortcut gives the wrong sign or limit',
        directives: [],
        visuals: {
            kinds: ['flow', 'matrix', 'cycle'],
            mapDepth: 3,
            bulletRatio: 1.1,
            condense: 'keep the governing relation, the assumptions it needs and the units convention; drop the derivation unless it is examinable',
        },
    },
    {
        id: 'mathematics',
        label: 'Mathematics',
        hints: ['theorem', 'proof', 'lemma', 'integral', 'derivative', 'matrix', 'equation', 'algebra', 'geometry', 'probability', 'رياضيات', 'معادلة', 'تفاضل'],
        safetyCritical: false,
        mechanism: 'why the object behaves as it does: the definition, the operation it supports, and what it generalises',
        reasoning: 'definition → property → proof or derivation → worked application → scope of validity',
        teach: 'give the definition and the one example that shows the definition doing work; never teach a rule without its domain of validity',
        transfer: 'a problem that is not isomorphic to the worked example, requiring the right tool to be chosen and its conditions checked',
        pitfalls: ['applying a rule outside its conditions', 'skipping cases or assuming non-degeneracy', 'algorithms without understanding'],
        authority: 'standard texts and reliable mathematical references',
        numbers: 'exact forms matter; be explicit about domains, ranges and equality versus approximation',
        questions: 'avoid questions answerable by pattern-matching the notation; ask for the step or the condition',
        directives: [
            'When a derivation is asked for, the learner must state the condition that licenses each step.',
        ],
        visuals: {
            kinds: ['flow', 'matrix'],
            mapDepth: 3,
            bulletRatio: 1.0,
            condense: 'keep the method in order, the conditions under which it applies and the classic trap; drop worked arithmetic',
        },
    },
    {
        id: 'statistics-data',
        label: 'Statistics & data',
        hints: ['sample', 'variance', 'regression', 'estimator', 'hypothesis', 'p-value', 'confidence', 'bayesian', 'dataset', 'statistics', 'إحصاء'],
        safetyCritical: false,
        mechanism: 'what is assumed, what is measured, and why the estimator or test is valid under those assumptions',
        reasoning: 'question → model/assumptions → estimator or test → interpretation → what would invalidate it',
        teach: 'state the estimand in plain words first, then the machinery; separate definition from interpretation',
        transfer: 'a new dataset description or output table requiring correct interpretation and a judgement on validity',
        pitfalls: ['misreading a p-value or confidence interval', 'confusing causation with association', 'ignoring sampling or assumption failures', 'base-rate neglect'],
        authority: 'statistical methodology references and the original study where relevant',
        numbers: 'preserve sample sizes, degrees of freedom, effect sizes and units exactly; never restate a CI as a probability of the parameter without saying what it means',
        questions: 'test interpretation of output, not recall of formulas alone',
        directives: [],
        visuals: {
            kinds: ['flow', 'matrix'],
            mapDepth: 3,
            bulletRatio: 1.1,
            condense: 'keep when each test applies and what assumption its violation breaks',
        },
    },
    {
        id: 'computing',
        label: 'Computing & software',
        hints: ['function', 'compiler', 'algorithm', 'api', 'database', 'runtime', 'code', 'recursion', 'complexity', 'typescript', 'python', 'برمجة', 'خوارزمية'],
        safetyCritical: false,
        mechanism: 'what the machine actually does: data flow, execution order, state changes and their cost',
        reasoning: 'input → state → transformation → output, with complexity and failure modes attached',
        teach: 'trace the smallest concrete example step by step; name the invariant that makes it work',
        transfer: 'an unfamiliar requirement, bug or performance constraint requiring the concept to be applied and defended',
        pitfalls: ['confusing the abstraction with the implementation', 'off-by-one and boundary conditions', 'ignoring error and edge cases', 'complexity intuition errors'],
        authority: 'official documentation, specifications and primary sources',
        numbers: 'be precise about complexity classes, limits, versions and byte/clock units',
        questions: 'prefer trace-the-behaviour and predict-the-output questions over definition recall',
        directives: [
            'When code is involved, show or trace code rather than describing it abstractly.',
        ],
        visuals: {
            kinds: ['flow', 'cycle', 'matrix'],
            mapDepth: 4,
            bulletRatio: 1.1,
            condense: 'keep the invariant, the complexity class and the failure mode; drop syntax any reference states',
        },
    },
    {
        id: 'engineering',
        label: 'Engineering',
        hints: ['load', 'stress', 'circuit', 'voltage', 'tolerance', 'torque', 'system', 'design specification', 'structural', 'هندسة', 'دائرة'],
        safetyCritical: true,
        mechanism: 'the physical or logical chain from input to output including the constraint that governs it',
        reasoning: 'requirement → governing relation → design/sizing decision → check against limits → failure mode',
        teach: 'state the requirement, then the relation, then the margin; always name the governing constraint',
        transfer: 'a new set of requirements or a changed constraint requiring a sizing, selection or troubleshooting decision',
        pitfalls: ['ignoring a limiting constraint', 'unit and factor-of-safety mistakes', 'confusing nominal and worst-case behaviour'],
        authority: 'standards, datasheets and discipline references',
        numbers: 'units, tolerances, safety factors and significant figures are part of the answer',
        questions: "include troubleshooting and 'what breaks first' style items",
        directives: [
            'Where a mistake would be physically unsafe, say so plainly and without hedging.',
        ],
        visuals: {
            kinds: ['flow', 'cycle', 'matrix'],
            mapDepth: 3,
            bulletRatio: 1.1,
            condense: 'keep the constraints, the governing equation and the safety margin; drop catalogue values',
        },
    },
    {
        id: 'law',
        label: 'Law & regulation',
        hints: ['statute', 'contract', 'tort', 'liability', 'jurisdiction', 'court', 'clause', 'regulation', 'plaintiff', 'قانون', 'عقد', 'محكمة', 'لائحة'],
        safetyCritical: false,
        mechanism: 'the rule and its elements: what must be shown, by whom, and to what standard',
        reasoning: 'issue → rule → elements → application to the facts → conclusion, with the counter-argument named',
        teach: 'state the test as an ordered list of elements, then walk the facts through it',
        transfer: 'new facts requiring the correct rule to be selected, its elements applied, and the strongest counter-argument addressed',
        pitfalls: ['conflating similar tests or standards of proof', 'mixing jurisdiction or version of the rule', 'conclusion without element-by-element application'],
        authority: 'the primary text (statute, regulation, judgment) and current official commentary',
        numbers: 'preserve time limits, thresholds, article and section numbers exactly',
        questions: 'require elements to be applied to facts, not recited; always ask for the counter-argument',
        directives: [
            'Never present a jurisdiction-specific answer without naming the jurisdiction assumed.',
            'This is study support, not legal advice — do not overstate certainty.',
        ],
        visuals: {
            kinds: ['flow', 'matrix', 'timeline'],
            mapDepth: 4,
            bulletRatio: 1.2,
            condense: 'keep every element of the test in order with the authority for it and the exception; drop case facts unless they define the rule',
        },
    },
    {
        id: 'business',
        label: 'Business & finance',
        hints: ['revenue', 'margin', 'market', 'customer', 'strategy', 'cash flow', 'valuation', 'pricing', 'accounting', 'تسويق', 'استثمار', 'محاسبة', 'أرباح'],
        safetyCritical: false,
        mechanism: 'the causal chain from a business choice to a measurable outcome, including the assumption it rests on',
        reasoning: 'objective → lever → mechanism → measurable outcome → assumption and sensitivity',
        teach: 'define the metric precisely, then show the causal chain that moves it, then one counter-case',
        transfer: 'a new situation or set of numbers requiring a decision and a defensible trade-off',
        pitfalls: ['confusing revenue with profit or cash', 'correlation treated as causation', 'ignoring the assumption behind a number', 'vanity metrics'],
        authority: 'primary financial statements, official filings and reputable industry data',
        numbers: 'state the time period and units of every figure; keep currency, margin type and basis explicit',
        questions: 'ask for the decision and the reasoning, not the definition of the term',
        directives: [],
        visuals: {
            kinds: ['matrix', 'flow', 'timeline'],
            mapDepth: 3,
            bulletRatio: 1.0,
            condense: 'keep the dimensions of the framework and the decision each one drives',
        },
    },
    {
        id: 'social-sciences',
        label: 'Social sciences',
        hints: ['behaviour', 'cognitive', 'society', 'theory', 'experiment', 'survey', 'culture', 'psychology', 'sociology', 'نفس', 'مجتمع'],
        safetyCritical: false,
        mechanism: 'the proposed process linking conditions to behaviour or outcomes, and the evidence for it',
        reasoning: 'claim → theoretical mechanism → evidence → competing explanation → what would falsify it',
        teach: 'separate the observable phenomenon, the explanation and the evidence for it; never let them merge',
        transfer: 'a new scenario requiring the right framework to be chosen and its limits stated',
        pitfalls: ['treating one study as settled knowledge', 'confusing a framework with a finding', 'ignoring effect sizes or replication status'],
        authority: 'peer-reviewed literature, meta-analyses and replication studies',
        numbers: 'preserve effect sizes, sample sizes and uncertainty exactly; never generalise a sample beyond its population',
        questions: 'always ask what evidence would count against the claim',
        directives: [],
        visuals: {
            kinds: ['matrix', 'flow'],
            mapDepth: 3,
            bulletRatio: 1.0,
            condense: 'keep the competing explanations and the evidence that separates them',
        },
    },
    {
        id: 'history-humanities',
        label: 'History & humanities',
        hints: ['century', 'empire', 'revolution', 'treaty', 'dynasty', 'period', 'movement', 'author', 'literature', 'تاريخ', 'حضارة', 'أدب'],
        safetyCritical: false,
        mechanism: 'why events unfolded as they did: causes, conditions and contingencies, in order, with the sources that support it',
        reasoning: 'context → cause → event → consequence → competing interpretation and its evidence',
        teach: 'give the timeline spine first, then attach causes to it; label contested claims as contested',
        transfer: 'an unfamiliar source extract, artefact or comparison requiring interpretation and contextualisation',
        pitfalls: ['chronology errors', 'confusing cause with correlation or with a later justification', 'presenting one interpretation as fact'],
        authority: 'primary sources and current scholarly consensus; note where scholarship disagrees',
        numbers: 'keep dates, durations and spans exact; never blur chronology for narrative smoothness',
        questions: 'ask for the evidence behind an interpretation, not just the interpretation',
        directives: [
            'Where historians disagree, say so and give the shape of the disagreement.',
        ],
        visuals: {
            kinds: ['timeline', 'matrix', 'flow'],
            mapDepth: 3,
            bulletRatio: 1.1,
            condense: 'keep dates, causes and consequences in order, and who did what to whom; drop scene-setting',
        },
    },
    {
        id: 'language',
        label: 'Language & linguistics',
        hints: ['grammar', 'verb', 'noun', 'phrase', 'pronunciation', 'vocabulary', 'syntax', 'translation', 'نحو', 'مفردات', 'ترجمة', 'قواعد'],
        safetyCritical: false,
        mechanism: 'the rule and what it is for: the pattern, the environments it applies in, and the exceptions',
        reasoning: "pattern → environments → exception → contrast with the learner's likely default",
        teach: 'give the pattern with two contrasting examples, then an exception, then have the learner produce new examples',
        transfer: 'producing novel sentences or interpreting unseen text, not recognising the rule',
        pitfalls: ['recognition without production', 'false friends and interference from a first language', 'over-applying a rule to exceptions'],
        authority: 'authoritative dictionaries, grammars and usage corpora',
        numbers: 'be explicit about register, politeness level and regional variation',
        questions: 'prefer production and transformation to multiple-choice recognition; give the learner the target language unless they ask otherwise',
        directives: [
            "Mirror the learner's language for meta-commentary, and the target language for the material being practised.",
        ],
        visuals: {
            kinds: ['matrix', 'flow'],
            mapDepth: 3,
            bulletRatio: 1.0,
            condense: 'keep the rule, its exceptions and one model sentence',
        },
    },
    {
        id: 'arts-media',
        label: 'Arts, music & design',
        hints: ['harmony', 'chord', 'scale', 'composition', 'colour', 'palette', 'composition', 'rhythm', 'art', 'music', 'فن', 'موسيقى', 'تصميم'],
        safetyCritical: false,
        mechanism: 'why the choice works: what the technique does to the material, the ear or the eye, and toward which effect',
        reasoning: 'intent → technique → effect on the audience/material → consequence → alternative choices',
        teach: 'name the technique, then immediately show it in a concrete case, then have the learner apply it',
        transfer: 'a new brief, constraint or piece requiring an intentional choice and a defence of it',
        pitfalls: ['naming techniques without being able to use them', 'copying the example instead of the principle', 'confusing taste with craft'],
        authority: 'established critical texts, primary works and practitioner sources',
        numbers: 'be exact about intervals, tempos, ranges, dimensions and proportions',
        questions: 'always ask for a produced artefact or a defended choice, not a definition',
        directives: [],
        visuals: {
            kinds: ['matrix', 'timeline'],
            mapDepth: 3,
            bulletRatio: 1.0,
            condense: 'keep the movement, its markers and what it reacted against',
        },
    },
    {
        id: 'philosophy-argument',
        label: 'Philosophy & argument',
        hints: ['argument', 'premise', 'fallacy', 'ethics', 'epistemology', 'metaphysics', 'logic', 'theology', 'فلسفة', 'منطق', 'أخلاق'],
        safetyCritical: false,
        mechanism: 'the structure of the argument: what is assumed, what follows, and what the move costs',
        reasoning: 'position → premises → inference → objection → reply',
        teach: 'reconstruct the argument explicitly before evaluating it; separate validity from truth',
        transfer: 'an unfamiliar position or objection requiring reconstruction, evaluation and a defended judgement',
        pitfalls: ['attacking a weaker version of a position', 'confusing validity with soundness', 'labelling a fallacy without showing the structure'],
        authority: 'primary texts and current peer-reviewed philosophy',
        numbers: 'be precise about modality, quantifiers and scope of a claim',
        questions: "ask for the strongest version of the opposing view, not just the learner's own",
        directives: [],
        visuals: {
            kinds: ['flow', 'matrix'],
            mapDepth: 4,
            bulletRatio: 1.1,
            condense: 'keep each premise, the inference it supports and the standard objection to it',
        },
    },
    {
        id: 'procedural',
        label: 'Practical skill & how-to',
        hints: ['step', 'process', 'prepare', 'procedure', 'equipment', 'ingredients', 'workflow', 'checklist', 'maintenance', 'خطوات', 'طريقة', 'تحضير'],
        safetyCritical: true,
        mechanism: 'why each step exists: what it does to the material, the state or the outcome, and what breaks if it is skipped',
        reasoning: 'goal → prerequisites → ordered steps → the signal that each step is done → failure modes',
        teach: 'one phase at a time, with the observable signal that tells the learner the phase is complete',
        transfer: 'a variation in conditions or equipment requiring the procedure to be adapted without losing its purpose',
        pitfalls: ['memorising steps without the reason', 'skipping a prerequisite', 'not recognising the signal that a step finished'],
        authority: 'manufacturer or practitioner documentation and reputable instruction sources',
        numbers: 'preserve quantities, temperatures, times, ratios and timings exactly',
        questions: 'place the learner in the middle of the process and ask what comes next, or what went wrong',
        directives: [
            'Where a step is safety-relevant, say so before teaching the step, not after.',
        ],
        visuals: {
            kinds: ['flow', 'matrix'],
            mapDepth: 3,
            bulletRatio: 1.2,
            condense: 'keep the steps in order, the checkpoints, and what to do when a step fails',
        },
    },
];

/** Look up a profile, falling back to the neutral default. */
export function getDomainProfile(id: string | null | undefined): StudyDomainProfile {
    if (!id) return STUDY_DOMAINS[0];
    return STUDY_DOMAINS.find(d => d.id === id) ?? STUDY_DOMAINS[0];
}

/**
 * Cheap, offline first-pass classification.
 *
 * Deliberately simple: it only breaks ties and gives the model a sensible
 * starting point, and the model may overrule it. Arabic and mixed-language
 * notes will often fall through to 'general' and be classified by the model
 * instead, which is fine — the registry is a scaffold, not a gatekeeper.
 */
export function detectDomain(text: string): { id: string; confidence: 'high' | 'low' } {
    const haystack = text.toLowerCase();
    let best: { id: string; score: number } | null = null;

    for (const profile of STUDY_DOMAINS) {
        if (profile.hints.length === 0) continue;
        let score = 0;
        for (const hint of profile.hints) {
            if (haystack.includes(hint)) score += 1;
        }
        if (score > 0 && (!best || score > best.score)) {
            best = { id: profile.id, score };
        }
    }

    if (!best) return { id: 'general', confidence: 'low' };
    return { id: best.id, confidence: best.score >= 3 ? 'high' : 'low' };
}

/** Build the domain adapter block injected into the tutor prompt. */
/**
 * The visual profile for a domain, falling back to the general one so callers
 * never have to branch on whether a discipline has been drawn before.
 */
export function visualsFor(profile: StudyDomainProfile | null | undefined): StudyVisualProfile {
    const general = STUDY_DOMAINS[0].visuals;
    return profile?.visuals ?? general ?? {
        kinds: ['matrix', 'flow'],
        mapDepth: 3,
        bulletRatio: 1.1,
        condense: 'keep the definitions and the one example that makes each one real',
    };
}

export function describeDomain(profile: StudyDomainProfile, domainNotes: string): string {
    const lines = [
        `Discipline: ${profile.label}`,
        `What "mechanism" means here: ${profile.mechanism}`,
        `Reasoning form to use: ${profile.reasoning}`,
        `How to explain: ${profile.teach}`,
        `What a transfer task looks like: ${profile.transfer}`,
        `Characteristic mistakes: ${profile.pitfalls.join('; ')}`,
        `Authoritative for a lookup: ${profile.authority}`,
        `Numbers and notation: ${profile.numbers}`,
        `Question cautions: ${profile.questions}`,
    ];
    const directives = [...SHARED_DIRECTIVES, ...profile.directives];
    lines.push(`Rules: ${directives.join(' ')}`);
    if (profile.safetyCritical) {
        lines.push('Errors here can have real-world consequences: treat dangerous misconceptions as blocking, not as minor slips.');
    }
    if (domainNotes.trim().length > 0) {
        lines.push(`Subject-specific notes from the learner's own chart: ${domainNotes.trim()}`);
    }
    return lines.join('\n');
}
