/**
 * =====================================================================================
 * CuidAção — Mapeamento de Farmácias Locais do Guarujá/SP (alocadas nos endereços reais)
 * -------------------------------------------------------------------------------------
 * Farmácias e drogarias reais distribuídas pelos bairros de origem no Guarujá/SP
 * (Perequê, Praia de Pernambuco, Enseada, Morrinhos, Vila Maia, Pitangueiras/Centro,
 * Astúrias/Vila Alzira, Vila Santa Rosa e Vicente de Carvalho), posicionadas sobre
 * seus respectivos logradouros.
 *
 * Formato de cada item:
 *   { id, nome, endereco, latitude, longitude, temFarmaciaPopular }
 * =====================================================================================
 */
window.CUIDACAO_FARMACIAS_MOCK = Object.freeze([
  {
    id: 'farm-guaruja-01',
    nome: 'Drogaria Perequê (Farma Unique)',
    endereco: 'Av. Rio Amazonas, 882 – Balneário Praia do Perequê, Guarujá/SP',
    latitude: -23.93380,
    longitude: -46.18230,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-02',
    nome: 'Drogaria & Farmácia Praia de Pernambuco',
    endereco: 'Av. Marjory da Silva Prado, 1100 – Balneário Praia do Pernambuco, Guarujá/SP',
    latitude: -23.96857,
    longitude: -46.18805,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-03',
    nome: 'Droga Raia – Enseada (Jardim Belmar)',
    endereco: 'Av. Dom Pedro I, 2810 – Enseada, Guarujá/SP',
    latitude: -23.97863,
    longitude: -46.22424,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-04',
    nome: 'Drogaria São Paulo – Enseada',
    endereco: 'Av. Dom Pedro I, 1574 – Enseada, Guarujá/SP',
    latitude: -23.98340,
    longitude: -46.23560,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-05',
    nome: 'Farmácias Nissei – Enseada',
    endereco: 'Av. Dom Pedro I, 1461 – Enseada, Guarujá/SP',
    latitude: -23.98315,
    longitude: -46.23668,
    temFarmaciaPopular: false
  },
  {
    id: 'farm-guaruja-06',
    nome: 'Golden Farma – Morrinhos',
    endereco: 'Av. Antenor Pimentel, 219 – Morrinhos, Guarujá/SP',
    latitude: -23.96501,
    longitude: -46.25116,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-07',
    nome: 'Raia Drogasil – Vila Maia',
    endereco: 'Av. Deputado Emílio Carlos, 333 – Vila Maia, Guarujá/SP',
    latitude: -23.98940,
    longitude: -46.25230,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-08',
    nome: 'Farmácias Pague Menos – Centro / Pitangueiras',
    endereco: 'Av. Puglisi, 310 – Centro / Pitangueiras, Guarujá/SP',
    latitude: -23.99251,
    longitude: -46.25845,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-09',
    nome: 'Droga Raia – Centro / Pitangueiras',
    endereco: 'Rua Mário Ribeiro, 835 – Centro / Pitangueiras, Guarujá/SP',
    latitude: -23.99758,
    longitude: -46.25971,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-10',
    nome: 'Drogaria São Paulo – Astúrias / Vila Alzira',
    endereco: 'Av. General Rondon, 150 – Vila Alzira / Astúrias, Guarujá/SP',
    latitude: -24.00430,
    longitude: -46.26830,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-11',
    nome: 'Drogaria São Paulo – Vila Santa Rosa',
    endereco: 'Av. Dr. Adhemar de Barros, 2105 – Vila Santa Rosa, Guarujá/SP',
    latitude: -23.99215,
    longitude: -46.27310,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-12',
    nome: 'Droga Raia – Vicente de Carvalho (Vila Alice)',
    endereco: 'Av. Thiago Ferreira, 787 – Vila Alice, Vicente de Carvalho, Guarujá/SP',
    latitude: -23.94265,
    longitude: -46.30143,
    temFarmaciaPopular: true
  },
  {
    id: 'farm-guaruja-13',
    nome: 'Farma Conde – Vicente de Carvalho (Vila Alice)',
    endereco: 'Av. Thiago Ferreira, 904 – Vila Alice, Vicente de Carvalho, Guarujá/SP',
    latitude: -23.94390,
    longitude: -46.30040,
    temFarmaciaPopular: true
  }
]);
