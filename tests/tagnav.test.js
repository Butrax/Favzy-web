// Tests du moteur de navigation par tags (cas listés dans le cahier des charges).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyze, buildIndex, fold, tagKey } from '../public/tagnav.js';

const fav = (id, ...tags) => ({ id, tags });
const LIBRARY = [
  fav('vst', 'Musique', 'Informatique', 'VST', 'MAO', 'Réverbération'),
  fav('run', 'Sport', 'Course à pied'),
  fav('mix', 'Musique', 'Instruments', 'Mixage'),
  fav('linux', 'Informatique', 'Linux'),
  fav('vide'), // favori sans tag
];
const index = buildIndex(LIBRARY);
const PRIMARY = new Set(['musique', 'informatique', 'sport']);

const run = (...selected) => analyze(LIBRARY, PRIMARY, selected.map(tagKey), index);
const ids = (view) => view.results.map((b) => b.id).sort();
const names = (list) => list.map((t) => t.name).sort((a, b) => a.localeCompare(b, 'fr'));

describe('navigation par tags', () => {
  test('1. aucun tag sélectionné : tout est affiché', () => {
    const view = run();
    assert.deepEqual(ids(view), ['linux', 'mix', 'run', 'vide', 'vst']);
    assert.deepEqual(names(view.primary), ['Informatique', 'Musique', 'Sport']);
    assert.deepEqual(view.primary.map((t) => [t.name, t.count]), [['Informatique', 2], ['Musique', 2], ['Sport', 1]]);
    assert.deepEqual(view.selected, []);
  });

  test('2. un tag principal : seuls les principaux compatibles restent (exemple du cahier des charges)', () => {
    const view = run('Musique');
    assert.deepEqual(ids(view), ['mix', 'vst']);
    assert.deepEqual(view.selected, [{ key: 'musique', name: 'Musique', primary: true }]);
    assert.deepEqual(names(view.primary), ['Informatique']); // Sport est masqué
    assert.deepEqual(names(view.secondary), ['Instruments', 'MAO', 'Mixage', 'Réverbération', 'VST']);
    assert.equal(view.primary[0].count, 1);
  });

  test('3. plusieurs tags principaux : intersection stricte, suggestions recalculées', () => {
    const view = run('Musique', 'Informatique');
    assert.deepEqual(ids(view), ['vst']);
    assert.deepEqual(view.primary, []); // Sport toujours masqué, rien d'autre à proposer
    assert.deepEqual(names(view.secondary), ['MAO', 'Réverbération', 'VST']); // Instruments et Mixage disparaissent
  });

  test('4. tags secondaires : ET avec les principaux, tags déjà choisis exclus', () => {
    const view = run('Musique', 'Informatique', 'VST', 'Réverbération');
    assert.deepEqual(ids(view), ['vst']);
    assert.deepEqual(names(view.secondary), ['MAO']);
    assert.ok(!view.secondary.some((t) => ['vst', 'réverbération'].includes(t.key)));
    assert.deepEqual(view.selected.map((t) => [t.name, t.primary]), [['Musique', true], ['Informatique', true], ['VST', false], ['Réverbération', false]]);
  });

  test('ET et non OU : Informatique + Sport ne donne rien', () => {
    const view = run('Informatique', 'Sport');
    assert.deepEqual(ids(view), []);
    assert.deepEqual(view.primary, []);
    assert.deepEqual(view.secondary, []);
  });

  test('5. désélection d\'un tag principal : recalcul, sans toucher aux autres filtres', () => {
    const before = run('Musique', 'Informatique', 'VST');
    assert.deepEqual(ids(before), ['vst']);
    const after = run('Musique', 'VST'); // Informatique retiré, VST conservé
    assert.deepEqual(ids(after), ['vst']);
    assert.deepEqual(names(after.primary), ['Informatique']); // il redevient proposé
    const wider = run('Musique'); // VST retiré aussi
    assert.deepEqual(ids(wider), ['mix', 'vst']);
    assert.ok(!wider.primary.some((t) => t.name === 'Sport'));
  });

  test('6. désélection d\'un tag secondaire : il redevient proposé avec son compteur', () => {
    const narrow = run('Musique', 'Instruments');
    assert.deepEqual(ids(narrow), ['mix']);
    assert.deepEqual(names(narrow.secondary), ['Mixage']);
    const wide = run('Musique');
    const instruments = wide.secondary.find((t) => t.name === 'Instruments');
    assert.equal(instruments.count, 1);
  });

  test('7. combinaison sans résultat : état vide, aucune suggestion, la sélection reste visible', () => {
    const view = run('Musique', 'Sport', 'Linux');
    assert.deepEqual(ids(view), []);
    assert.deepEqual(view.primary, []);
    assert.deepEqual(view.secondary, []);
    assert.equal(view.selected.length, 3); // l'utilisateur peut retirer chaque filtre
  });

  test('8. réinitialisation : retour à la bibliothèque complète', () => {
    assert.deepEqual(ids(run('Musique', 'VST')), ['vst']);
    assert.deepEqual(ids(run()), ['linux', 'mix', 'run', 'vide', 'vst']);
  });

  test('les compteurs portent sur les favoris de la sélection courante', () => {
    const view = run('Informatique');
    assert.deepEqual(view.secondary.map((t) => [t.name, t.count]).sort(), [['Linux', 1], ['MAO', 1], ['Réverbération', 1], ['VST', 1]]);
    assert.equal(view.primary.find((t) => t.name === 'Musique').count, 1);
  });

  test('la restriction par la recherche texte s\'applique aussi aux suggestions', () => {
    const onlyLinux = analyze(LIBRARY.filter((b) => b.id === 'linux'), PRIMARY, [], index);
    assert.deepEqual(names(onlyLinux.primary), ['Informatique']);
    assert.deepEqual(names(onlyLinux.secondary), ['Linux']);
  });

  test('un tag qui change de catégorie est classé selon la liste des principaux', () => {
    const asPrimary = analyze(LIBRARY, new Set([...PRIMARY, 'vst']), [], index);
    assert.ok(asPrimary.primary.some((t) => t.name === 'VST'));
    assert.ok(!asPrimary.secondary.some((t) => t.name === 'VST'));
  });

  test('tri déterministe : compteur décroissant puis ordre alphabétique', () => {
    const view = run();
    assert.deepEqual(view.secondary.map((t) => t.name), ['Course à pied', 'Instruments', 'Linux', 'MAO', 'Mixage', 'Réverbération', 'VST']);
    assert.deepEqual(run('Informatique').secondary.map((t) => t.name), run('Informatique').secondary.map((t) => t.name));
  });

  test('casse, accents et doublons', () => {
    const view = analyze(LIBRARY, PRIMARY, ['musique', 'musique'], index); // sélection en double ignorée
    assert.deepEqual(ids(view), ['mix', 'vst']);
    assert.equal(view.selected.length, 1);
    assert.equal(tagKey('  MUSIQUE '), 'musique');
    assert.equal(fold('Réverbération'), 'reverberation');
    assert.ok(fold('Réverbération').includes(fold('reverb')));
    const mixed = [fav('a', 'musique'), fav('b', 'Musique')];
    assert.equal(buildIndex(mixed).get('musique').total, 2); // une seule entrée, deux favoris
  });
});
