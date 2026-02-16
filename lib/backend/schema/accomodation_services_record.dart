import 'dart:async';

import '/backend/algolia/serialization_util.dart';
import '/backend/algolia/algolia_manager.dart';
import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class AccomodationServicesRecord extends FirestoreRecord {
  AccomodationServicesRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  bool hasName() => _name != null;

  // "category" field.
  DocumentReference? _category;
  DocumentReference? get category => _category;
  bool hasCategory() => _category != null;

  // "price" field.
  double? _price;
  double get price => _price ?? 0.0;
  bool hasPrice() => _price != null;

  // "duration" field.
  int? _duration;
  int get duration => _duration ?? 0;
  bool hasDuration() => _duration != null;

  // "staffInvolved" field.
  int? _staffInvolved;
  int get staffInvolved => _staffInvolved ?? 0;
  bool hasStaffInvolved() => _staffInvolved != null;

  // "qualifications" field.
  List<DocumentReference>? _qualifications;
  List<DocumentReference> get qualifications => _qualifications ?? const [];
  bool hasQualifications() => _qualifications != null;

  // "calendarReservations" field.
  int? _calendarReservations;
  int get calendarReservations => _calendarReservations ?? 0;
  bool hasCalendarReservations() => _calendarReservations != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  bool hasAccomodation() => _accomodation != null;

  void _initializeFields() {
    _name = snapshotData['name'] as String?;
    _category = snapshotData['category'] as DocumentReference?;
    _price = castToType<double>(snapshotData['price']);
    _duration = castToType<int>(snapshotData['duration']);
    _staffInvolved = castToType<int>(snapshotData['staffInvolved']);
    _qualifications = getDataList(snapshotData['qualifications']);
    _calendarReservations =
        castToType<int>(snapshotData['calendarReservations']);
    _accomodation = snapshotData['accomodation'] as DocumentReference?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('accomodationServices');

  static Stream<AccomodationServicesRecord> getDocument(
          DocumentReference ref) =>
      ref.snapshots().map((s) => AccomodationServicesRecord.fromSnapshot(s));

  static Future<AccomodationServicesRecord> getDocumentOnce(
          DocumentReference ref) =>
      ref.get().then((s) => AccomodationServicesRecord.fromSnapshot(s));

  static AccomodationServicesRecord fromSnapshot(DocumentSnapshot snapshot) =>
      AccomodationServicesRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static AccomodationServicesRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      AccomodationServicesRecord._(reference, mapFromFirestore(data));

  static AccomodationServicesRecord fromAlgolia(
          AlgoliaObjectSnapshot snapshot) =>
      AccomodationServicesRecord.getDocumentFromData(
        {
          'name': snapshot.data['name'],
          'category': convertAlgoliaParam(
            snapshot.data['category'],
            ParamType.DocumentReference,
            false,
          ),
          'price': convertAlgoliaParam(
            snapshot.data['price'],
            ParamType.double,
            false,
          ),
          'duration': convertAlgoliaParam(
            snapshot.data['duration'],
            ParamType.int,
            false,
          ),
          'staffInvolved': convertAlgoliaParam(
            snapshot.data['staffInvolved'],
            ParamType.int,
            false,
          ),
          'qualifications': safeGet(
            () => convertAlgoliaParam<DocumentReference>(
              snapshot.data['qualifications'],
              ParamType.DocumentReference,
              true,
            ).toList(),
          ),
          'calendarReservations': convertAlgoliaParam(
            snapshot.data['calendarReservations'],
            ParamType.int,
            false,
          ),
          'accomodation': convertAlgoliaParam(
            snapshot.data['accomodation'],
            ParamType.DocumentReference,
            false,
          ),
        },
        AccomodationServicesRecord.collection.doc(snapshot.objectID),
      );

  static Future<List<AccomodationServicesRecord>> search({
    String? term,
    FutureOr<LatLng>? location,
    int? maxResults,
    double? searchRadiusMeters,
    bool useCache = false,
  }) =>
      FFAlgoliaManager.instance
          .algoliaQuery(
            index: 'accomodationServices',
            term: term,
            maxResults: maxResults,
            location: location,
            searchRadiusMeters: searchRadiusMeters,
            useCache: useCache,
          )
          .then((r) => r.map(fromAlgolia).toList());

  @override
  String toString() =>
      'AccomodationServicesRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is AccomodationServicesRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createAccomodationServicesRecordData({
  String? name,
  DocumentReference? category,
  double? price,
  int? duration,
  int? staffInvolved,
  int? calendarReservations,
  DocumentReference? accomodation,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'name': name,
      'category': category,
      'price': price,
      'duration': duration,
      'staffInvolved': staffInvolved,
      'calendarReservations': calendarReservations,
      'accomodation': accomodation,
    }.withoutNulls,
  );

  return firestoreData;
}

class AccomodationServicesRecordDocumentEquality
    implements Equality<AccomodationServicesRecord> {
  const AccomodationServicesRecordDocumentEquality();

  @override
  bool equals(AccomodationServicesRecord? e1, AccomodationServicesRecord? e2) {
    const listEquality = ListEquality();
    return e1?.name == e2?.name &&
        e1?.category == e2?.category &&
        e1?.price == e2?.price &&
        e1?.duration == e2?.duration &&
        e1?.staffInvolved == e2?.staffInvolved &&
        listEquality.equals(e1?.qualifications, e2?.qualifications) &&
        e1?.calendarReservations == e2?.calendarReservations &&
        e1?.accomodation == e2?.accomodation;
  }

  @override
  int hash(AccomodationServicesRecord? e) => const ListEquality().hash([
        e?.name,
        e?.category,
        e?.price,
        e?.duration,
        e?.staffInvolved,
        e?.qualifications,
        e?.calendarReservations,
        e?.accomodation
      ]);

  @override
  bool isValidKey(Object? o) => o is AccomodationServicesRecord;
}
